// bot/db.js — PostgreSQL wrapper + schema + queries (v4: + applications, whitelist, sessions, ton_fees)
const postgres = require('postgres');
const { Address } = require('@ton/core');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(1); }

const sql = postgres(DATABASE_URL, { ssl: 'prefer', max: 5, idle_timeout: 20, connect_timeout: 10 });

// ── Address normalization ─────────────────────────────────────────────────
// Приводим любой адрес к raw-формату (0:hex) для единообразного сравнения.
function normAddr(a) {
  try { return Address.parse(a).toRawString(); }
  catch { return String(a || '').toLowerCase(); }
}

async function migrate() {
  await sql`
    CREATE TABLE IF NOT EXISTS locks (
      lock_id BIGINT PRIMARY KEY,
      creator TEXT NOT NULL,
      beneficiary TEXT NOT NULL,
      jetton_master TEXT NOT NULL,
      amount NUMERIC NOT NULL,
      claimed_amount NUMERIC NOT NULL DEFAULT 0,
      unlock_at BIGINT NOT NULL,
      lockup_wallet TEXT NOT NULL,
      factory TEXT NOT NULL,
      fee_jetton NUMERIC NOT NULL DEFAULT 0,
      funded BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`;
  
  await sql`ALTER TABLE locks ADD COLUMN IF NOT EXISTS fee_jetton NUMERIC NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE locks ADD COLUMN IF NOT EXISTS funded BOOLEAN NOT NULL DEFAULT FALSE`;

  await sql`
    CREATE TABLE IF NOT EXISTS lock_events (
      id SERIAL PRIMARY KEY,
      lock_id BIGINT NOT NULL,
      event_type TEXT NOT NULL,
      event_data JSONB NOT NULL,
      tx_hash TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS indexer_cursor (
      id INT PRIMARY KEY DEFAULT 1,
      last_lt BIGINT NOT NULL DEFAULT 0,
      last_hash TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`;
  await sql`INSERT INTO indexer_cursor (id, last_lt, last_hash) VALUES (1, 0, NULL) ON CONFLICT (id) DO NOTHING`;
  await sql`UPDATE indexer_cursor SET last_lt = 0, last_hash = NULL WHERE id = 1 AND (last_hash IS NULL OR LENGTH(last_hash) <> 64)`;

  await sql`
    CREATE TABLE IF NOT EXISTS whitelist (
      jetton_master TEXT PRIMARY KEY,
      name TEXT,
      symbol TEXT,
      description TEXT,
      applicant TEXT,
      approved_at TIMESTAMPTZ DEFAULT NOW(),
      metadata JSONB DEFAULT '{}'::jsonb
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS applications (
      id SERIAL PRIMARY KEY,
      jetton_master TEXT NOT NULL UNIQUE,
      applicant TEXT NOT NULL,
      telegram_id BIGINT,
      applicant_name TEXT,
      project_url TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      decision_reason TEXT,
      decided_by TEXT,
      decided_at TIMESTAMPTZ,
      due_diligence JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS factory_state (
      id INT PRIMARY KEY DEFAULT 1,
      ton_fees_accumulated NUMERIC NOT NULL DEFAULT 0,
      ton_fees_withdrawn NUMERIC NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`;
  await sql`INSERT INTO factory_state (id, ton_fees_accumulated, ton_fees_withdrawn)
            VALUES (1, 0, 0) ON CONFLICT (id) DO NOTHING`;

  console.log('Database migrated (v4.1)');
}

const big = (v) => BigInt(v ?? 0);

async function getCursor() {
  const rows = await sql`SELECT last_lt, last_hash FROM indexer_cursor WHERE id = 1`;
  return { lt: big(rows[0] && rows[0].last_lt), hash: rows[0] && rows[0].last_hash };
}

async function setCursor(lt, hash) {
  await sql`UPDATE indexer_cursor SET last_lt = ${lt.toString()}, last_hash = ${hash}, updated_at = NOW() WHERE id = 1`;
}

async function insertLock(l) {
  const amount = big(l.amount);
  const fee = (amount * 50n) / 10000n;
  await sql`
    INSERT INTO locks (lock_id, creator, beneficiary, jetton_master, amount, unlock_at, lockup_wallet, factory, fee_jetton)
    VALUES (
      ${String(l.lock_id)},
      ${normAddr(l.creator)},
      ${normAddr(l.beneficiary)},
      ${normAddr(l.jetton_master)},
      ${String(l.amount)}, ${String(l.unlock_at)},
      ${normAddr(l.lockup_wallet)},
      ${normAddr(l.factory)},
      ${fee.toString()}
    ) ON CONFLICT (lock_id) DO NOTHING`;
  await sql`UPDATE factory_state
            SET ton_fees_accumulated = ton_fees_accumulated + 1000000000, updated_at = NOW()
            WHERE id = 1`;
}

async function markClaimed(lockId, amount) {
  await sql`UPDATE locks SET claimed_amount = ${String(amount)} WHERE lock_id = ${String(lockId)}`;
}

async function markExtended(lockId, newUnlockAt) {
  await sql`UPDATE locks SET unlock_at = ${String(newUnlockAt)} WHERE lock_id = ${String(lockId)}`;
}

// ── markFunded — фиксирует, что LockFunded (0x124) пришёл и замок получил жетоны
async function markFunded(lockId) {
  await sql`UPDATE locks SET funded = TRUE WHERE lock_id = ${String(lockId)}`;
  console.log('LockFunded #' + lockId + ' → funded=TRUE');
}

async function insertEvent(e) {
  await sql`
    INSERT INTO lock_events (lock_id, event_type, event_data, tx_hash)
    VALUES (${String(e.lock_id)}, ${e.event_type}, ${sql.json(e.event_data)}, ${e.tx_hash})
    ON CONFLICT (tx_hash) DO NOTHING`;
}

// ── getLocks — ищем по raw-адресу (единый формат после normAddr в insertLock)
async function getLocks(wallet) {
  const w = normAddr(wallet);
  return await sql`
    SELECT *, CASE
      WHEN claimed_amount >= amount THEN 'claimed'
      WHEN unlock_at <= EXTRACT(EPOCH FROM NOW()) THEN 'ready'
      ELSE 'locked'
    END AS status
    FROM locks
    WHERE creator = ${w} OR beneficiary = ${w}
    ORDER BY lock_id DESC LIMIT 100`;
}

async function getOpenLocks() {
  return await sql`SELECT * FROM locks WHERE claimed_amount < amount ORDER BY lock_id LIMIT 20`;
}

async function getStats() {
  const now = Math.floor(Date.now() / 1000);
  const t = await sql`SELECT COUNT(*)::int AS c FROM locks`;
  const a = await sql`SELECT COUNT(*)::int AS c FROM locks WHERE claimed_amount < amount AND unlock_at > ${now}`;
  const r = await sql`SELECT COUNT(*)::int AS c FROM locks WHERE claimed_amount < amount AND unlock_at <= ${now}`;
  const v = await sql`SELECT COALESCE(SUM(amount - claimed_amount), 0) AS s FROM locks WHERE claimed_amount < amount`;
  const f = await sql`SELECT COALESCE(SUM(fee_jetton), 0) AS s FROM locks`;
  const fs = await sql`SELECT ton_fees_accumulated, ton_fees_withdrawn FROM factory_state WHERE id = 1`;
  return {
    total_locks: t[0].c, locked: a[0].c, ready_to_claim: r[0].c,
    tvl_nano: v[0].s.toString(),
    jetton_fees_nano: f[0].s.toString(),
    ton_fees_accumulated: (fs[0] && fs[0].ton_fees_accumulated).toString(),
    ton_fees_withdrawn: (fs[0] && fs[0].ton_fees_withdrawn).toString(),
  };
}

// ---- v4: whitelist ----
async function listWhitelist() {
  return await sql`SELECT * FROM whitelist ORDER BY approved_at DESC`;
}
async function upsertWhitelist(row) {
  await sql`
    INSERT INTO whitelist (jetton_master, name, symbol, description, applicant, metadata)
    VALUES (${normAddr(row.jetton_master)}, ${row.name || null}, ${row.symbol || null},
            ${row.description || null}, ${row.applicant || null}, ${sql.json(row.metadata || {})})
    ON CONFLICT (jetton_master) DO UPDATE SET
      name = EXCLUDED.name, symbol = EXCLUDED.symbol, description = EXCLUDED.description,
      applicant = EXCLUDED.applicant, metadata = EXCLUDED.metadata, approved_at = NOW()`;
}
async function removeWhitelist(jettonMaster) {
  await sql`DELETE FROM whitelist WHERE jetton_master = ${normAddr(jettonMaster)}`;
}

// ---- v4: applications ----
async function listApplications(status) {
  if (status) {
    return await sql`SELECT * FROM applications WHERE status = ${status} ORDER BY created_at DESC`;
  }
  return await sql`SELECT * FROM applications ORDER BY CASE status
      WHEN 'pending' THEN 0 WHEN 'approved' THEN 2 ELSE 1 END, created_at DESC`;
}
async function getApplication(id) {
  const rows = await sql`SELECT * FROM applications WHERE id = ${id}`;
  return rows[0] || null;
}
async function getApplicationByMaster(jettonMaster) {
  const rows = await sql`SELECT * FROM applications WHERE jetton_master = ${normAddr(jettonMaster)}`;
  return rows[0] || null;
}
async function insertApplication(a) {
  const rows = await sql`
    INSERT INTO applications (jetton_master, applicant, telegram_id, applicant_name, project_url, notes)
    VALUES (${normAddr(a.jetton_master)}, ${a.applicant}, ${a.telegram_id || null},
            ${a.applicant_name || null}, ${a.project_url || null}, ${a.notes || null})
    ON CONFLICT (jetton_master) DO UPDATE SET
      applicant = EXCLUDED.applicant, telegram_id = EXCLUDED.telegram_id,
      applicant_name = EXCLUDED.applicant_name, project_url = EXCLUDED.project_url,
      notes = EXCLUDED.notes, status = 'pending', decision_reason = NULL, decided_at = NULL
    RETURNING *`;
  return rows[0];
}
async function decideApplication(id, status, reason, decidedBy, dueDiligence) {
  await sql`
    UPDATE applications SET
      status = ${status}, decision_reason = ${reason || null},
      decided_by = ${decidedBy || null}, decided_at = NOW(),
      due_diligence = ${sql.json(dueDiligence || {})}
    WHERE id = ${id}`;
}

// ---- v4: admin sessions ----
async function createSession(token, expiresAt) {
  await sql`INSERT INTO admin_sessions (token, expires_at) VALUES (${token}, ${expiresAt})`;
}
async function getSession(token) {
  const rows = await sql`SELECT * FROM admin_sessions WHERE token = ${token} AND expires_at > NOW()`;
  return rows[0] || null;
}
async function deleteSession(token) {
  await sql`DELETE FROM admin_sessions WHERE token = ${token}`;
}
async function purgeExpiredSessions() {
  await sql`DELETE FROM admin_sessions WHERE expires_at <= NOW()`;
}
async function listEvents(limit) {
  return await sql`SELECT * FROM lock_events ORDER BY id DESC LIMIT ${limit}`;
}

async function close() { await sql.end(); }
// ==== v5: Public Vaults Summary ====
async function getPublicVaultsSummary() {
  const total = await sql`
    SELECT COUNT(*)::int AS total_locks,
           COALESCE(SUM(amount - claimed_amount), 0)::bigint AS total_tvl_nano
    FROM locks 
    WHERE funded = true AND claimed_amount < amount
  `;
  
  const byJetton = await sql`
    SELECT jetton_master, 
           COUNT(*)::int AS locks,
           COALESCE(SUM(amount - claimed_amount), 0)::bigint AS tvl_nano
    FROM locks 
    WHERE funded = true AND claimed_amount < amount
    GROUP BY jetton_master 
    ORDER BY tvl_nano DESC
  `;
  
  return { total: total[0], by_jetton: byJetton };
}

async function getLocksByJetton(jettonMaster) {
  return await sql`
    SELECT lock_id, amount, claimed_amount, unlock_at, lockup_wallet, creator, beneficiary, funded
    FROM locks 
    WHERE jetton_master = ${normAddr(jettonMaster)}
    AND funded = true
    ORDER BY lock_id DESC`;
}

module.exports = {
  migrate, getCursor, setCursor, insertLock, markClaimed, markExtended, markFunded, insertEvent,
  getLocks, getOpenLocks, getStats, close,
  listWhitelist, upsertWhitelist, removeWhitelist,
  listApplications, getApplication, getApplicationByMaster, insertApplication, decideApplication,
  createSession, getSession, deleteSession, purgeExpiredSessions, listEvents, getPublicVaultsSummary, getLocksByJetton,
};
