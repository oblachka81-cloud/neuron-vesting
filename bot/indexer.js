// bot/indexer.js — polls factory + lockup wallets, parses v2.1 events
BigInt.prototype.toJSON = function () { return this.toString(); };

const { Address } = require('@ton/core');
const { TonClient } = require('@ton/ton');
const db = require('./db');

const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS;
const NETWORK = process.env.NETWORK || 'testnet';

const client = new TonClient({
  endpoint: `https://${NETWORK === 'testnet' ? 'testnet.' : ''}toncenter.com/api/v2/jsonRPC`,
  apiKey: process.env.TONCENTER_API_KEY,
});

function parseEvent(body) {
  if (!body || body.bits.length < 32) return null;
  const s = body.beginParse();
  const op = s.loadUint(32);
  if (op === 0x100) return { type: 'LockCreated', lock_id: Number(s.loadUintBig(64)), creator: s.loadAddress().toString(), beneficiary: s.loadAddress().toString(), jetton: s.loadAddress().toString(), amount: s.loadCoins().toString(), unlock_at: Number(s.loadUintBig(64)) };
  if (op === 0x101) return { type: 'Claimed', lock_id: Number(s.loadUintBig(64)), amount: s.loadCoins().toString(), beneficiary: s.loadAddress().toString() };
  if (op === 0x102) return { type: 'Extended', lock_id: Number(s.loadUintBig(64)), old_unlock_at: Number(s.loadUintBig(64)), new_unlock_at: Number(s.loadUintBig(64)) };
  if (op === 0x103) return { type: 'WalletVerified', lock_id: Number(s.loadUintBig(64)), wallet: s.loadAddress().toString() };
  if (op === 0x104) return { type: 'WithdrawBounced', query_id: Number(s.loadUintBig(64)), amount: s.loadCoins().toString() };
  if (op === 0x105) return { type: 'ClaimBounced', lock_id: Number(s.loadUintBig(64)), amount: s.loadCoins().toString() };
  if (op === 0x106) return { type: 'TonFeeCollected', lock_id: Number(s.loadUintBig(64)), amount: s.loadCoins().toString() };
  return null;
}

const seen = new Set();
const eventKey = (addr, lt, type) => addr + ':' + lt + ':' + type;

async function pollFactory() {
  const cursor = await db.getCursor();
  const txs = await client.getTransactions(Address.parse(FACTORY_ADDRESS), { limit: 20 });
  let maxLt = cursor.lt;
  for (const tx of txs.slice().reverse()) {
    const lt = BigInt(tx.lt);
    if (lt <= cursor.lt) continue;
    if (lt > maxLt) maxLt = lt;
    let created = null;
    let child = null;
    for (const msg of tx.outMessages.values()) {
      if (msg.info.type === 'external-out') {
        const ev = parseEvent(msg.body);
        if (ev && ev.type === 'LockCreated') created = ev;
      } else if (msg.info.type === 'internal' && msg.init) {
        child = msg.info.dest.toString();
      }
    }
    if (created) {
      await db.insertLock({ ...created, jetton_master: created.jetton, lockup_wallet: child || '', factory: FACTORY_ADDRESS });
      await db.insertEvent({ lock_id: created.lock_id, event_type: 'LockCreated', event_data: created, tx_hash: eventKey(FACTORY_ADDRESS, tx.lt, 'LockCreated') });
      console.log('Indexed LockCreated #' + created.lock_id, '->', child);
    }
  }
  if (maxLt > cursor.lt) await db.setCursor(maxLt, null);
}

let tick = 0;
async function pollWallets() {
  tick++;
  if (tick % 5 !== 0) return;
  const locks = await db.getOpenLocks();
  for (const lock of locks) {
    if (!lock.lockup_wallet) continue;
    try {
      const txs = await client.getTransactions(Address.parse(lock.lockup_wallet), { limit: 10 });
      for (const tx of txs) {
        for (const msg of tx.outMessages.values()) {
          if (msg.info.type !== 'external-out') continue;
          const ev = parseEvent(msg.body);
          if (!ev) continue;
          const key = eventKey(lock.lockup_wallet, tx.lt, ev.type);
          if (seen.has(key)) continue;
          seen.add(key);
          await db.insertEvent({ lock_id: ev.lock_id || 0, event_type: ev.type, event_data: ev, tx_hash: key });
          if (ev.type === 'Claimed') await db.markClaimed(ev.lock_id, ev.amount);
          if (ev.type === 'Extended') await db.markExtended(ev.lock_id, ev.new_unlock_at);
          console.log('Indexed', ev.type, '#' + (ev.lock_id || 0));
        }
      }
      await new Promise((r) => setTimeout(r, 300));
    } catch (e) { /* wallet not active yet */ }
  }
}

async function loop() {
  for (;;) {
    try {
      await pollFactory();
      await pollWallets();
    } catch (e) {
      console.error('Indexer poll error:', e.message);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

module.exports = { loop };
