// bot/indexer.js — polls factory + lockup wallets, parses v2.5.1/v2.6.1 events
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

// ── Event parser — v2.5.1 factory + v2.6.1 wallet opcodes ────────────────
// Factory events:   0x100..0x11F
// Wallet events:    0x124..0x12A
function parseEvent(body) {
  if (!body || body.bits.length < 32) return null;
  const s = body.beginParse();
  const op = s.loadUint(32);

  // ── Factory events (0x100-0x11F) ─────────────────────────────────────
  if (op === 0x100) return {
    type: 'LockCreated',
    lock_id: Number(s.loadUintBig(64)),
    creator: s.loadAddress().toString(),
    beneficiary: s.loadAddress().toString(),
    jetton: s.loadAddress().toString(),
    amount: s.loadCoins().toString(),
    unlock_at: Number(s.loadUintBig(64)),
  };
  if (op === 0x104) return {
    type: 'WithdrawBounced',
    query_id: Number(s.loadUintBig(64)),
    amount: s.loadCoins().toString(),
  };
  if (op === 0x106) return {
    type: 'TonFeeCollected',
    lock_id: Number(s.loadUintBig(64)),
    amount: s.loadCoins().toString(),
  };
  if (op === 0x107) return {
    type: 'FeesWithdrawn',
    query_id: Number(s.loadUintBig(64)),
    jetton_master: s.loadAddress().toString(),
    amount: s.loadCoins().toString(),
    destination: s.loadAddress().toString(),
  };
  if (op === 0x108) return {
    type: 'OverpayRefunded',
    creator: s.loadAddress().toString(),
    amount: s.loadCoins().toString(),
  };
  if (op === 0x109) return {
    type: 'JettonWalletSet',
    jetton_master: s.loadAddress().toString(),
    jetton_wallet: s.loadAddress().toString(),
  };
  if (op === 0x110) return {
    type: 'TonFeesWithdrawn',
    query_id: Number(s.loadUintBig(64)),
    amount: s.loadCoins().toString(),
    destination: s.loadAddress().toString(),
  };
  if (op === 0x111) return {
    type: 'LockCreationFailed',
    lock_id: Number(s.loadUintBig(64)),
    creator: s.loadAddress().toString(),
    beneficiary: s.loadAddress().toString(),
    jetton: s.loadAddress().toString(),
    amount: s.loadCoins().toString(),
  };
  if (op === 0x112) return {
    type: 'CreateBounced',
    lock_id: Number(s.loadUintBig(64)),
    amount: s.loadCoins().toString(),
  };

  // ── Wallet events (0x124-0x12A) ──────────────────────────────────────
  if (op === 0x124) return {
    type: 'Claimed',
    lock_id: Number(s.loadUintBig(64)),
    amount: s.loadCoins().toString(),
    beneficiary: s.loadAddress().toString(),
    query_id: Number(s.loadUintBig(64)),
  };
  if (op === 0x125) return {
    type: 'Extended',
    lock_id: Number(s.loadUintBig(64)),
    old_unlock_at: Number(s.loadUintBig(64)),
    new_unlock_at: Number(s.loadUintBig(64)),
  };
  if (op === 0x126) return {
    type: 'ClaimBounced',
    lock_id: Number(s.loadUintBig(64)),
    amount: s.loadCoins().toString(),
    query_id: Number(s.loadUintBig(64)),
  };
  if (op === 0x127) return {
    type: 'PendingClaimReset',
    lock_id: Number(s.loadUintBig(64)),
    amount: s.loadCoins().toString(),
    query_id: Number(s.loadUintBig(64)),
  };
  if (op === 0x128) return {
    type: 'StaleBounceIgnored',
    lock_id: Number(s.loadUintBig(64)),
    query_id: Number(s.loadUintBig(64)),
    pending_query_id: Number(s.loadUintBig(64)),
  };
  if (op === 0x129) return {
    type: 'LockFunded',
    lock_id: Number(s.loadUintBig(64)),
    amount: s.loadCoins().toString(),
    query_id: Number(s.loadUintBig(64)),
  };
  if (op === 0x12A) return {
    type: 'UnexpectedDeposit',
    lock_id: Number(s.loadUintBig(64)),
    sender: s.loadAddress().toString(),
    amount: s.loadCoins().toString(),
  };

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
          if (ev.type === 'LockFunded') await db.markFunded && db.markFunded(ev.lock_id);
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
