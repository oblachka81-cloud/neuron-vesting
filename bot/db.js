// bot/db.js — PostgreSQL wrapper with schema migration
const postgres = require('postgres');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, {
  ssl: 'require',
  max: 5,
  idle_timeout: 20,
  connect_timeout: 10,
});

async function migrate() {
  await sql`
    CREATE TABLE IF NOT EXISTS locks (
      lock_id BIGINT PRIMARY KEY,
      creator TEXT NOT NULL,
      beneficiary TEXT NOT NULL,
      jetton_master TEXT NOT NULL,
      amount NUMERIC NOT NULL,
      unlock_at BIGINT NOT NULL,
      lockup_wallet TEXT NOT NULL,
      factory TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS lock_events (
      id SERIAL PRIMARY KEY,
      lock_id BIGINT NOT NULL,
      event_type TEXT NOT NULL,
      event_data JSONB NOT NULL,
      tx_hash TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS indexer_cursor (
      id INT PRIMARY KEY DEFAULT 1,
      factory TEXT NOT NULL,
      last_lt BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    INSERT INTO indexer_cursor (id, factory, last_lt)
    VALUES (1, ${process.env.FACTORY_ADDRESS || ''}, 0)
    ON CONFLICT (id) DO NOTHING
  `;
  console.log('Database migrated');
}

async function getCursor() {
  const rows = await sql`SELECT last_lt FROM indexer_cursor WHERE id = 1`;
  return rows[0]?.last_lt || 0n;
}

async function setCursor(lt) {
  await sql`UPDATE indexer_cursor SET last_lt = ${lt}, updated_at = NOW() WHERE id = 1`;
}

async function insertLock(lock) {
  await sql`
    INSERT INTO locks (lock_id, creator, beneficiary, jetton_master, amount, unlock_at, lockup_wallet, factory)
    VALUES (${lock.lock_id}, ${lock.creator}, ${lock.beneficiary}, ${lock.jetton_master}, ${lock.amount}, ${lock.unlock_at}, ${lock.lockup_wallet}, ${lock.factory})
    ON CONFLICT (lock_id) DO NOTHING
  `;
}

async function insertEvent(event) {
  await sql`
    INSERT INTO lock_events (lock_id, event_type, event_data, tx_hash)
    VALUES (${event.lock_id}, ${event.event_type}, ${sql.json(event.event_data)}, ${event.tx_hash})
    ON CONFLICT (tx_hash) DO NOTHING
  `;
}

async function getLocks(wallet) {
  return await sql`
    SELECT * FROM locks
    WHERE creator = ${wallet} OR beneficiary = ${wallet}
    ORDER BY lock_id DESC
    LIMIT 100
  `;
}

async function getStats() {
  const total = await sql`SELECT COUNT(*) as count FROM locks`;
  const active = await sql`SELECT COUNT(*) as count FROM locks WHERE unlock_at > ${Math.floor(Date.now() / 1000)}`;
  const tvl = await sql`SELECT COALESCE(SUM(amount), 0) as total FROM locks WHERE unlock_at > ${Math.floor(Date.now() / 1000)}`;
  return {
    total_locks: parseInt(total[0].count),
    active_locks: parseInt(active[0].count),
    tvl_nano: tvl[0].total.toString(),
  };
}

async function close() {
  await sql.end();
}

module.exports = { migrate, getCursor, setCursor, insertLock, insertEvent, getLocks, getStats, close };
