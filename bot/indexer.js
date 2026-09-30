// bot/indexer.js — polls factory + lockup wallets, parses v5.0.3 factory / v5.1.1 wallet events
BigInt.prototype.toJSON = function () {
  return this.toString();
};

const { Address } = require('@ton/core');
const { TonClient } = require('@ton/ton');
const db = require('./db');

const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS;
const NETWORK = process.env.NETWORK || 'mainnet';

const client = new TonClient({
  endpoint: `https://${NETWORK === 'testnet' ? 'testnet.' : ''}toncenter.com/api/v2/jsonRPC`,
  apiKey: process.env.TONCENTER_API_KEY,
});

class RateLimiter {
  constructor(baseMs, maxMs) {
    this.base = baseMs;
    this.max = maxMs;
    this.cur = baseMs;
    this.chain = Promise.resolve();
  }
  async call(fn) {
    const run = this.chain.then(async () => {
      await new Promise((r) => setTimeout(r, this.cur));
      try {
        const data = await fn();
        this.cur = this.base;
        return { ok: true, data };
      } catch (e) {
        const msg = String((e && e.message) || '');
        if (msg.includes('429')) {
          this.cur = Math.min(this.cur * 2, this.max);
          return { ok: false };
        }
        throw e;
      }
    });
    this.chain = run.catch(() => {});
    return run;
  }
}
const limiter = new RateLimiter(1100, 5000);

function parseEvent(body) {
  try {
    if (!body || typeof body.beginParse !== 'function') return null;
    const s = body.beginParse();
    if (s.remainingBits < 32) return null;
    const op = s.loadUint(32);

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
    if (op === 0x106) {
      return { type: 'TonFeeCollected', lock_id: Number(s.loadUintBig(64)), amount: s.loadCoins().toString() };
    }
    if (op === 0x107) {
      return {
        type: 'FeesWithdrawn',
        query_id: Number(s.loadUintBig(64)),
        jetton_master: s.loadAddress().toString(),
        amount: s.loadCoins().toString(),
        destination: s.loadAddress().toString(),
      };
    }
    if (op === 0x109) {
      return { type: 'JettonWalletSet', jetton_master: s.loadAddress().toString(), jetton_wallet: s.loadAddress().toString() };
    }
    if (op === 0x111) {
      return {
        type: 'LockCreationFailed',
        lock_id: Number(s.loadUintBig(64)),
        creator: s.loadAddress().toString(),
        jetton: s.loadAddress().toString(),
        amount: s.loadCoins().toString(),
      };
    }
    if (op === 0x112) {
      return { type: 'CreateBounced', lock_id: Number(s.loadUintBig(64)), amount: s.loadCoins().toString() };
    }
    if (op === 0x115) {
      return { type: 'RefundRequired', creator: s.loadAddress().toString(), jetton: s.loadAddress().toString(), amount: s.loadCoins().toString() };
    }
    if (op === 0x124) {
      return { type: 'LockFunded', lock_id: Number(s.loadUintBig(64)), amount: s.loadCoins().toString() };
    }
    if (op === 0x125) {
      return {
        type: 'Claimed',
        lock_id: Number(s.loadUintBig(64)),
        amount: s.loadCoins().toString(),
        beneficiary: s.loadAddress().toString(),
        beneficiary_wallet: s.loadAddress().toString(),
      };
    }
    if (op === 0x126) {
      return { type: 'ClaimBounced', lock_id: Number(s.loadUintBig(64)), amount: s.loadCoins().toString() };
    }
    if (op === 0x127) {
      return { type: 'ClaimReset', lock_id: Number(s.loadUintBig(64)), query_id: Number(s.loadUintBig(64)) };
    }
    if (op === 0x128) {
      return { type: 'ClaimSettled', lock_id: Number(s.loadUintBig(64)), amount: s.loadCoins().toString(), query_id: Number(s.loadUintBig(64)) };
    }
    return null;
  } catch (e) {
    console.error('PARSE FAIL ::', e.message);
    return null;
  }
}

const eventKey = (addr, lt, type) => addr + ':' + lt + ':' + type;

// ClaimSettled comes in the same tx as destroy -> wallet dies instantly and
// v2 stops returning its history. So once a dispatch (0x125) is seen on a live
// wallet, poll that wallet every tick until 0x128 lands.
const HOT_TTL_MS = 60000;
const hot = new Map();

async function handleWalletEvents(wallet, txs) {
  for (const tx of txs.slice().reverse()) {
    for (const msg of tx.outMessages.values()) {
      if (msg.info.type !== 'external-out') continue;
      const ev = parseEvent(msg.body);
      if (!ev) continue;
      const key = eventKey(wallet, tx.lt, ev.type);
      const inserted = await db.insertEvent({
        lock_id: ev.lock_id || 0,
        event_type: ev.type,
        event_data: ev,
        tx_hash: key,
      });
      if (!inserted) continue;

      if (ev.type === 'LockFunded') await db.markFunded(ev.lock_id);
      if (ev.type === 'ClaimSettled') {
        await db.markClaimed(ev.lock_id, ev.amount);
        hot.delete(wallet);
      }
      if (ev.type === 'Claimed') {
        hot.set(wallet, { lock_id: ev.lock_id, ts: Date.now() });
      }
      console.log('Indexed', ev.type, '#' + (ev.lock_id || 0));
    }
  }
}

async function pollFactory() {
  if (!FACTORY_ADDRESS) {
    console.error('FACTORY_ADDRESS not set');
    return;
  }
  const cursor = await db.getCursor();
  const r = await limiter.call(() => client.getTransactions(Address.parse(FACTORY_ADDRESS), { limit: 50 }));
  if (!r.ok) return;
  const txs = r.data;
  let maxLt = cursor.lt;

  for (const tx of txs.slice().reverse()) {
    try {
      const lt = BigInt(tx.lt);
      if (lt <= cursor.lt) continue;
      if (lt > maxLt) maxLt = lt;

      let created = null;
      let child = null;
      let unlockFromPayload = 0;
      let notifyAmount = null;
      let tonFee = null;

      try {
        const inMsg = tx.inMessage;
        if (inMsg && inMsg.info.type === 'internal' && inMsg.body) {
          const s = inMsg.body.beginParse();
          if (s.remainingBits >= 32 && s.preloadUint(32) === 0x7362d09c) {
            s.loadUint(32);
            s.loadUint(64);
            notifyAmount = s.loadCoins().toString();
            s.loadAddress();
            let fp = s;
            if (s.remainingBits > 0) {
              const isRef = s.loadBit();
              if (isRef) fp = s.loadRef().beginParse();
            }
            if (fp.remainingBits >= 32 && fp.preloadUint(32) === 0x1) {
              fp.loadUint(32);
              fp.loadUint(64);
              fp.loadAddress();
              fp.loadAddress();
              unlockFromPayload = Number(fp.loadUintBig(64));
            }
          }
        }
      } catch (e) {
        console.error('payload skip:', e.message);
      }

      for (const msg of tx.outMessages.values()) {
        try {
          if (msg.info.type === 'external-out' && msg.body) {
            const ev = parseEvent(msg.body);
            if (ev && ev.type === 'LockCreated') created = ev;
            if (ev && ev.type === 'TonFeeCollected') tonFee = ev.amount;
          } else if (msg.info.type === 'internal' && msg.init && msg.info.dest) {
            child = msg.info.dest.toString();
          }
        } catch (e) {
          console.error('msg skip:', e.message);
        }
      }

      if (created && child) {
        const rec = { ...created, unlock_at: created.unlock_at || unlockFromPayload };
        let feeJetton = '0';
        if (notifyAmount) {
          try {
            const original = BigInt(notifyAmount);
            const locked = BigInt(rec.amount);
            if (original >= locked) feeJetton = (original - locked).toString();
          } catch (e) {
            console.error('fee calc skip:', e.message);
          }
        }
        await db.insertLock({
          ...rec,
          jetton_master: rec.jetton,
          lockup_wallet: child,
          factory: FACTORY_ADDRESS,
          fee_jetton: feeJetton,
          ton_fee: tonFee || '0',
        });
        const inserted = await db.insertEvent({
          lock_id: rec.lock_id,
          event_type: 'LockCreated',
          event_data: rec,
          tx_hash: eventKey(FACTORY_ADDRESS, tx.lt, 'LockCreated'),
        });
        if (inserted) console.log('Indexed LockCreated #' + rec.lock_id, '->', child);
      }
    } catch (e) {
      console.error('tx skip:', e.message);
    }
  }

  if (maxLt > cursor.lt) await db.setCursor(maxLt, null);
}

let rr = 0;
async function pollWalletsOne() {
  const locks = await db.getOpenLocks();
  if (locks.length === 0) { rr = 0; return; }
  if (rr >= locks.length) rr = 0;
  const lock = locks[rr];
  rr = (rr + 1) % locks.length;
  if (!lock.lockup_wallet) return;

  // Fallback: 0x128 can be lost if the wallet self-destructs before we read
  // its history (429, timing). A destroyed wallet == successful full claim.
  try {
    const st = await limiter.call(() => client.getContractState(Address.parse(lock.lockup_wallet)));
    if (st.ok && st.data && (st.data.state === 'nonexistent' || st.data.state === 'uninitialized')) {
      console.log('Wallet destroyed -> auto-close lock #' + lock.lock_id);
      await db.markClaimed(lock.lock_id, null);
      return;
    }
  } catch (e) {}

  const r = await limiter.call(() => client.getTransactions(Address.parse(lock.lockup_wallet), { limit: 50 }));
  if (!r.ok) return;
  await handleWalletEvents(lock.lockup_wallet, r.data);
}

async function pollHotOne() {
  const entries = [...hot.entries()];
  if (entries.length === 0) return;
  const [wallet, meta] = entries[0];

  if (Date.now() - meta.ts > HOT_TTL_MS) {
    // Same fallback as pollWalletsOne, but for wallets stuck in the hot window.
    try {
      const st = await limiter.call(() => client.getContractState(Address.parse(wallet)));
      if (st.ok && st.data && (st.data.state === 'nonexistent' || st.data.state === 'uninitialized')) {
        console.log('Hot TTL expired, wallet destroyed -> auto-close lock #' + meta.lock_id);
        await db.markClaimed(meta.lock_id, null);
      }
    } catch (e) {}
    hot.delete(wallet);
    return;
  }

  const r = await limiter.call(() => client.getTransactions(Address.parse(wallet), { limit: 50 }));
  if (!r.ok) return;
  await handleWalletEvents(wallet, r.data);
}

let cycle = 0;
async function loop() {
  for (;;) {
    try {
      if (hot.size > 0) {
        await pollHotOne();
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      cycle++;
      if (cycle % 3 === 0) await pollFactory();
      await pollWalletsOne();
      await new Promise((r) => setTimeout(r, 3000));
    } catch (e) {
      console.error('Indexer poll error:', e.message);
    }
  }
}

module.exports = { loop };
