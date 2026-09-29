// bot/indexer.js — polls factory + lockup wallets, parses v5.0.3 factory / v5.1.1 wallet events
//
// Tempo model (built for ONE free toncenter key, ~1 rps shared with the frontend):
//   - A single global RateLimiter serializes EVERY toncenter call (factory + all
//     wallets) behind one interval, so parallel awaits cannot bypass the throttle.
//   - Base interval 1100ms; on any 429 it doubles (capped 5000ms) to back off the
//     shared quota the frontend is also burning; on success it resets to base.
//   - Factory is polled every ~3 loops (its events are the source of truth for
//     lock creation / fees and must not be missed).
//   - Wallets are polled ROUND-ROBIN, ONE per loop, so request rate is constant
//     regardless of how many open locks exist. A full pass takes N loops; settlement
//     may lag a few seconds on large N, which is fine for vesting (not HFT).
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

// ── Global adaptive rate limiter ──────────────────────────────────────────
class RateLimiter {
  constructor(baseMs, maxMs) {
    this.base = baseMs;
    this.max = maxMs;
    this.cur = baseMs;
    this.chain = Promise.resolve(); // serialized queue of all calls
  }

  // Runs fn after the current interval, on the global chain. Returns
  // { ok:true, data } on success, { ok:false } on 429 (caller skips iteration),
  // and rethrows non-429 errors (network etc.) so the caller can log them.
  async call(fn) {
    const run = this.chain.then(async () => {
      await new Promise((r) => setTimeout(r, this.cur));
      try {
        const data = await fn();
        this.cur = this.base; // success -> reset backoff
        return { ok: true, data };
      } catch (e) {
        const msg = String((e && e.message) || '');
        if (msg.includes('429')) {
          this.cur = Math.min(this.cur * 2, this.max); // shared-quota pressure
          return { ok: false };
        }
        throw e;
      }
    });
    // Keep the chain alive even if this call rejected a non-429 error.
    this.chain = run.catch(() => {});
    return run;
  }
}

const limiter = new RateLimiter(1100, 5000);

// ── Event parser (field order byte-verified against contracts v5.0.3/v5.1.1) ──
function parseEvent(body) {
  try {
    if (!body || typeof body.beginParse !== 'function') return null;

    const s = body.beginParse();
    if (s.remainingBits < 32) return null;

    const op = s.loadUint(32);

    // ── Factory v5.0.3 ──
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
      return {
        type: 'TonFeeCollected',
        lock_id: Number(s.loadUintBig(64)),
        amount: s.loadCoins().toString(),
      };
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
      return {
        type: 'JettonWalletSet',
        jetton_master: s.loadAddress().toString(),
        jetton_wallet: s.loadAddress().toString(),
      };
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
      return {
        type: 'CreateBounced',
        lock_id: Number(s.loadUintBig(64)),
        amount: s.loadCoins().toString(),
      };
    }

    if (op === 0x115) {
      return {
        type: 'RefundRequired',
        creator: s.loadAddress().toString(),
        jetton: s.loadAddress().toString(),
        amount: s.loadCoins().toString(),
      };
    }

    // ── Wallet v5.1.1 ──
    if (op === 0x124) {
      return {
        type: 'LockFunded',
        lock_id: Number(s.loadUintBig(64)),
        amount: s.loadCoins().toString(),
      };
    }

    // Claimed (0x125) = DISPATCH, not payout. Never markClaimed on this.
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
      return {
        type: 'ClaimBounced',
        lock_id: Number(s.loadUintBig(64)),
        amount: s.loadCoins().toString(),
      };
    }

    // ClaimReset (v5.1.0) — stuck claim cleared by beneficiary.
    if (op === 0x127) {
      return {
        type: 'ClaimReset',
        lock_id: Number(s.loadUintBig(64)),
        query_id: Number(s.loadUintBig(64)),
      };
    }

    // ClaimSettled (v5.1.1) = CONFIRMED payout. The only event that drives markClaimed.
    if (op === 0x128) {
      return {
        type: 'ClaimSettled',
        lock_id: Number(s.loadUintBig(64)),
        amount: s.loadCoins().toString(),
        query_id: Number(s.loadUintBig(64)),
      };
    }

    return null;
  } catch (e) {
    console.error('PARSE FAIL ::', e.message);
    return null;
  }
}

const eventKey = (addr, lt, type) => addr + ':' + lt + ':' + type;

// ── Factory poll (one toncenter call through the limiter) ─────────────────
async function pollFactory() {
  if (!FACTORY_ADDRESS) {
    console.error('FACTORY_ADDRESS not set');
    return;
  }

  const cursor = await db.getCursor();

  const r = await limiter.call(() =>
    client.getTransactions(Address.parse(FACTORY_ADDRESS), { limit: 50 })
  );
  if (!r.ok) return; // 429 -> limiter backed off, skip this cycle
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

      // Recover original jetton amount + unlock_at from the incoming notification.
      try {
        const inMsg = tx.inMessage;
        if (inMsg && inMsg.info.type === 'internal' && inMsg.body) {
          const s = inMsg.body.beginParse();
          if (s.remainingBits >= 32 && s.preloadUint(32) === 0x7362d09c) {
            s.loadUint(32); // op
            s.loadUint(64); // query_id
            notifyAmount = s.loadCoins().toString(); // original jetton amount
            s.loadAddress(); // sender
            let fp = s;
            if (s.remainingBits > 0) {
              const isRef = s.loadBit();
              if (isRef) fp = s.loadRef().beginParse();
            }
            if (fp.remainingBits >= 32 && fp.preloadUint(32) === 0x1) {
              fp.loadUint(32); // op
              fp.loadUint(64); // qid
              fp.loadAddress(); // jetton_master
              fp.loadAddress(); // beneficiary
              unlockFromPayload = Number(fp.loadUintBig(64));
            }
          }
        }
      } catch (e) {
        console.error('payload skip:', e.message);
      }

      // Outgoing events + child deployment.
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

        if (inserted) {
          console.log('Indexed LockCreated #' + rec.lock_id, '->', child);
        }
      }
    } catch (e) {
      console.error('tx skip:', e.message);
    }
  }

  if (maxLt > cursor.lt) await db.setCursor(maxLt, null);
}

// ── Wallet poll: ROUND-ROBIN, one lock per loop (constant request rate) ────
let rr = 0; // round-robin pointer into the open-locks list

async function pollWalletsOne() {
  const locks = await db.getOpenLocks();
  if (locks.length === 0) { rr = 0; return; }
  if (rr >= locks.length) rr = 0; // list shrank since last loop

  const lock = locks[rr];
  rr = (rr + 1) % locks.length;

  if (!lock.lockup_wallet) return;

  const r = await limiter.call(() =>
    client.getTransactions(Address.parse(lock.lockup_wallet), { limit: 50 })
  );
  if (!r.ok) return; // 429 -> backed off, this lock retried next full pass
  const txs = r.data;

  // oldest -> newest so dispatch precedes settle in the tape
  for (const tx of txs.slice().reverse()) {
    for (const msg of tx.outMessages.values()) {
      if (msg.info.type !== 'external-out') continue;
      const ev = parseEvent(msg.body);
      if (!ev) continue;

      const key = eventKey(lock.lockup_wallet, tx.lt, ev.type);
      const inserted = await db.insertEvent({
        lock_id: ev.lock_id || 0,
        event_type: ev.type,
        event_data: ev,
        tx_hash: key,
      });

      // Duplicate after restart / re-poll: do not touch aggregates.
      if (!inserted) continue;

      if (ev.type === 'LockFunded') await db.markFunded(ev.lock_id);
      if (ev.type === 'ClaimSettled') await db.markClaimed(ev.lock_id, ev.amount);

      console.log('Indexed', ev.type, '#' + (ev.lock_id || 0));
    }
  }
}

// ── Loop: factory every ~3 cycles, one wallet per cycle ───────────────────
let cycle = 0;

async function loop() {
  for (;;) {
    try {
      cycle++;
      if (cycle % 3 === 0) await pollFactory(); // source of truth, higher priority
      await pollWalletsOne(); // round-robin, one request
    } catch (e) {
      console.error('Indexer poll error:', e.message);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

module.exports = { loop };
