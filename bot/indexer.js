// bot/indexer.js — polls factory + lockup wallets, parses events, writes to DB
BigInt.prototype.toJSON = function () { return this.toString(); };

const { Address, beginCell, storeTransaction } = require('@ton/core');
const { TonClient } = require('@ton/ton');
const db = require('./db');

const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS;
const NETWORK = process.env.NETWORK || 'testnet';

const client = new TonClient({
  endpoint: `https://${NETWORK === 'testnet' ? 'testnet.' : ''}toncenter.com/api/v2/jsonRPC`,
  apiKey: process.env.TONCENTER_API_KEY,
});

function parseEvent(body) {
  if (body.bits.length < 32) return null;
  const s = body.beginParse();
  const op = s.loadUint(32);
  if (op === 0x100) return { type: 'LockCreated', lock_id: Number(s.loadUintBig(64)), creator: s.loadAddress().toString(), beneficiary: s.loadAddress().toString(), jetton: s.loadAddress().toString(), amount: s.loadCoins().toString(), unlock_at: Number(s.loadUintBig(64)) };
  if (op === 0x101) return { type: 'Claimed', lock_id: Number(s.loadUintBig(64)), amount: s.loadCoins().toString(), beneficiary: s.loadAddress().toString() };
  if (op === 0x102) return { type: 'Extended', lock_id: Number(s.loadUintBig(64)), old_unlock_at: Number(s.loadUintBig(64)), new_unlock_at: Number(s.loadUintBig(64)) };
  return null;
}

const txHashOf = (tx) => beginCell().store(storeTransaction(tx)).endCell().hash().toString('hex');

async function pollFactory() {
  const cursor = await db.getCursor();
  const opts = { limit: 20, archival: false };
  if (cursor.lt > 0n && cursor.hash) {
    opts.lt = cursor.lt.toString();
    opts.hash = cursor.hash;
  }
  let txs = [];
  try {
    txs = await client.getTransactions(Address.parse(FACTORY_ADDRESS), opts);
  } catch (e) {
    console.error('getTransactions 422 detail:', e.response?.data || e.message);
    throw e;
  }
  let maxLt = cursor.lt;
  let maxHash = cursor.hash;
  for (const tx of txs.slice().reverse()) {
    const lt = BigInt(tx.lt);
    if (cursor.lt > 0n && lt <= cursor.lt) continue;
    if (lt > maxLt) {
      maxLt = lt;
      maxHash = txHashOf(tx);
    }
    const hash = txHashOf(tx);
    let created = null, child = null;
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
      await db.insertEvent({ lock_id: created.lock_id, event_type: 'LockCreated', event_data: created, tx_hash: hash });
      console.log('Indexed LockCreated #' + created.lock_id, '->', child);
    }
  }
  if (maxLt > cursor.lt) await db.setCursor(maxLt, maxHash);
}

let tick = 0;
async function pollWallets() {
  tick++;
  if (tick % 5 !== 0) return; // ~every 15s
  const locks = await db.getOpenLocks();
  for (const lock of locks) {
    if (!lock.lockup_wallet) continue;
    try {
      const txs = await client.getTransactions(Address.parse(lock.lockup_wallet), { limit: 10 });
      for (const tx of txs) {
        const hash = txHashOf(tx);
        for (const msg of tx.outMessages.values()) {
          if (msg.info.type !== 'external-out') continue;
          const ev = parseEvent(msg.body);
          if (!ev || (ev.type !== 'Claimed' && ev.type !== 'Extended')) continue;
          await db.insertEvent({ lock_id: ev.lock_id, event_type: ev.type, event_data: ev, tx_hash: hash });
          if (ev.type === 'Claimed') await db.markClaimed(ev.lock_id, ev.amount);
          if (ev.type === 'Extended') await db.markExtended(ev.lock_id, ev.new_unlock_at);
          console.log('Indexed', ev.type, '#' + ev.lock_id);
        }
      }
      await new Promise((r) => setTimeout(r, 300));
    } catch (e) { /* wallet not initialized yet */ }
  }
}

async function loop() {
  for (;;) {
    try { await pollFactory(); await pollWallets(); }
    catch (e) { console.error('Indexer poll error:', e.message); }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

module.exports = { loop };
