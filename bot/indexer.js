// bot/indexer.js — polls factory + lockup wallets, parses v5.0.3 factory / v5.1.1 wallet events
BigInt.prototype.toJSON = function () { return this.toString(); };

const { Address } = require('@ton/core');
const { TonClient } = require('@ton/ton');
const db = require('./db');

const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS;
const NETWORK = process.env.NETWORK || 'mainnet';

const client = new TonClient({
  endpoint: `https://${NETWORK === 'testnet' ? 'testnet.' : ''}toncenter.com/api/v2/jsonRPC`,
  apiKey: process.env.TONCENTER_API_KEY,
});

function parseEvent(body) {
  try {
    if (!body || typeof body.beginParse !== 'function') return null;
    const s = body.beginParse();
    if (s.remainingBits < 32) return null;
    const op = s.loadUint(32);

    // ── Factory v5.0.3 (unchanged layout) ──
    if (op === 0x100) {
      const ev = {
        type: 'LockCreated',
        lock_id: Number(s.loadUintBig(64)),
        creator: s.loadAddress().toString(),
        beneficiary: s.loadAddress().toString(),
        jetton: s.loadAddress().toString(),
        amount: s.loadCoins().toString(),
      };
      ev.unlock_at = s.remainingBits >= 64 ? Number(s.loadUintBig(64)) : 0;
      return ev;
    }
    if (op === 0x106) return { type: 'TonFeeCollected', lock_id: Number(s.loadUintBig(64)), amount: s.loadCoins().toString() };
    if (op === 0x107) return { type: 'FeesWithdrawn', query_id: Number(s.loadUintBig(64)), jetton_master: s.loadAddress().toString(), amount: s.loadCoins().toString(), destination: s.loadAddress().toString() };
    if (op === 0x109) return { type: 'JettonWalletSet', jetton_master: s.loadAddress().toString(), jetton_wallet: s.loadAddress().toString() };
    if (op === 0x111) return { type: 'LockCreationFailed', lock_id: Number(s.loadUintBig(64)), creator: s.loadAddress().toString(), jetton: s.loadAddress().toString(), amount: s.loadCoins().toString() };
    if (op === 0x112) return { type: 'CreateBounced', lock_id: Number(s.loadUintBig(64)), amount: s.loadCoins().toString() };
    if (op === 0x115) return { type: 'RefundRequired', creator: s.loadAddress().toString(), jetton: s.loadAddress().toString(), amount: s.loadCoins().toString() };

    // ── Wallet v5.1.1 ──
    if (op === 0x124) return { type: 'LockFunded', lock_id: Number(s.loadUintBig(64)), amount: s.loadCoins().toString() };
    // Claimed (0x125) = DISPATCH, not payout. Never markClaimed on this.
    if (op === 0x125) return { type: 'Claimed', lock_id: Number(s.loadUintBig(64)), amount: s.loadCoins().toString(), beneficiary: s.loadAddress().toString(), beneficiary_wallet: s.loadAddress().toString() };
    if (op === 0x126) return { type: 'ClaimBounced', lock_id: Number(s.loadUintBig(64)), amount: s.loadCoins().toString() };
    // ResetPendingClaim (v5.1.0) — stuck claim cleared by beneficiary.
    if (op === 0x127) return { type: 'ClaimReset', lock_id: Number(s.loadUintBig(64)), query_id: Number(s.loadUintBig(64)) };
    // ClaimSettled (v5.1.1) = CONFIRMED payout. The only event that drives markClaimed.
    if (op === 0x128) return { type: 'ClaimSettled', lock_id: Number(s.loadUintBig(64)), amount: s.loadCoins().toString(), query_id: Number(s.loadUintBig(64)) };

    return null;
  } catch (e) {
    console.error('PARSE FAIL ::', e.message);
    return null;
  }
}

const seen = new Set();
const eventKey = (addr, lt, type) => addr + ':' + lt + ':' + type;

async function pollFactory() {
  if (!FACTORY_ADDRESS) { console.error('FACTORY_ADDRESS not set'); return; }
  const cursor = await db.getCursor();
  const txs = await client.getTransactions(Address.parse(FACTORY_ADDRESS), { limit: 30 });
  let maxLt = cursor.lt;

  for (const tx of txs.slice().reverse()) {
    try {
      const lt = BigInt(tx.lt);
      if (lt <= cursor.lt) continue;
      if (lt > maxLt) maxLt = lt;

      let created = null;
      let child = null;
      let unlockFromPayload = 0;

      for (const msg of tx.outMessages.values()) {
        try {
          if (msg.info.type === 'external-out' && msg.body) {
            const ev = parseEvent(msg.body);
            if (ev && ev.type === 'LockCreated') created = ev;
          } else if (msg.info.type === 'internal' && msg.init && msg.info.dest) {
            child = msg.info.dest.toString();
          }
        } catch (e) { console.error('msg skip:', e.message); }
      }

      try {
        const inMsg = tx.inMessage;
        if (inMsg && inMsg.info.type === 'internal' && inMsg.body) {
          const s = inMsg.body.beginParse();
          if (s.remainingBits >= 32 && s.preloadUint(32) === 0x7362d09c) {
            s.loadUint(32); s.loadUint(64); s.loadCoins(); s.loadAddress();
            const fp = s.loadBit() ? s.loadRef().beginParse() : s;
            if (fp.remainingBits >= 32 && fp.preloadUint(32) === 0x1) {
              fp.loadUint(32); fp.loadUint(64);
              fp.loadAddress(); fp.loadAddress();
              unlockFromPayload = Number(fp.loadUintBig(64));
            }
          }
        }
      } catch (e) { console.error('payload skip:', e.message); }

      if (created && child) {
        const rec = { ...created, unlock_at: created.unlock_at || unlockFromPayload };
        await db.insertLock({ ...rec, jetton_master: rec.jetton, lockup_wallet: child, factory: FACTORY_ADDRESS });
        await db.insertEvent({ lock_id: rec.lock_id, event_type: 'LockCreated', event_data: rec, tx_hash: eventKey(FACTORY_ADDRESS, tx.lt, 'LockCreated') });
        console.log('Indexed LockCreated #' + rec.lock_id, '->', child, 'unlock_at:', rec.unlock_at);
      }
    } catch (e) { console.error('tx skip:', e.message); }
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
      // reverse: oldest->newest so Claimed(dispatch) precedes ClaimSettled(confirm) in the tape
      for (const tx of txs.slice().reverse()) {
        for (const msg of tx.outMessages.values()) {
          if (msg.info.type !== 'external-out') continue;
          const ev = parseEvent(msg.body);
          if (!ev) continue;
          const key = eventKey(lock.lockup_wallet, tx.lt, ev.type);
          if (seen.has(key)) continue;
          seen.add(key);
          await db.insertEvent({ lock_id: ev.lock_id || 0, event_type: ev.type, event_data: ev, tx_hash: key });

          // Aggregate ONLY on confirmed state changes. Dispatch/bounce/reset stay in the tape.
          if (ev.type === 'LockFunded') await db.markFunded(ev.lock_id);
          if (ev.type === 'ClaimSettled') await db.markClaimed(ev.lock_id, ev.amount); // v5.1.1: payout confirmed
          if (ev.type === 'Extended') await db.markExtended(ev.lock_id, ev.new_unlock_at);
          console.log('Indexed', ev.type, '#' + (ev.lock_id || 0));
        }
      }
      await new Promise((r) => setTimeout(r, 300));
    } catch (e) {
      console.error('Poll wallet error for', lock.lockup_wallet, ':', e.message);
    }
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
