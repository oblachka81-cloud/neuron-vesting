// bot/db.js — PostgreSQL wrapper + schema + queries
const postgres = require('postgres');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(1); }

const sql = postgres(DATABASE_URL, { ssl: 'prefer', max: 5, idle_timeout: 20, connect_timeout: 10 });

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
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`;
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
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`;
  await sql`INSERT INTO indexer_cursor (id, last_lt) VALUES (1, 0) ON CONFLICT (id) DO NOTHING`;
  console.log('Database migrated');
}

const big = (v) => BigInt(v ?? 0);

async function getCursor() {
  const rows = await sql`SELECT last_lt FROM indexer_cursor WHERE id = 1`;
  return big(rows[0] && rows[0].last_lt);
}
async function setCursor(lt) {
  await sql`UPDATE indexer_cursor SET last_lt = ${lt.toString()}, updated_at = NOW() WHERE id = 1`;
}

async function insertLock(l) {
  await sql`
    INSERT INTO locks (lock_id, creator, beneficiary, jetton_master, amount, unlock_at, lockup_wallet, factory)
    VALUES (${String(l.lock_id)}, ${l.creator}, ${l.beneficiary}, ${l.jetton_master}, ${l.amount}, ${String(l.unlock_at)}, ${l.lockup_wallet}, ${l.factory})
    ON CONFLICT (lock_id) DO NOTHING`;
}
async function markClaimed(lockId, amount) {
  await sql`UPDATE locks SET claimed_amount = ${amount} WHERE lock_id = ${String(lockId)}`;
}
async function markExtended(lockId, newUnlockAt) {
  await sql`UPDATE locks SET unlock_at = ${String(newUnlockAt)} WHERE lock_id = ${String(lockId)}`;
}
async function insertEvent(e) {
  await sql`
    INSERT INTO lock_events (lock_id, event_type, event_data, tx_hash)
    VALUES (${String(e.lock_id)}, ${e.event_type}, ${sql.json(e.event_data)}, ${e.tx_hash})
    ON CONFLICT (tx_hash) DO NOTHING`;
}

async function getLocks(wallet) {
  return await sql`
    SELECT *, CASE
      WHEN claimed_amount >= amount THEN 'claimed'
      WHEN unlock_at <= EXTRACT(EPOCH FROM NOW()) THEN 'ready'
      ELSE 'locked'
    END AS status
    FROM locks
    WHERE creator = ${wallet} OR beneficiary = ${wallet}
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
  return { total_locks: t[0].c, locked: a[0].c, ready_to_claim: r[0].c, tvl_nano: v[0].s.toString() };
}
async function close() { await sql.end(); }

module.exports = { migrate, getCursor, setCursor, insertLock, markClaimed, markExtended, insertEvent, getLocks, getOpenLocks, getStats, close };
