// bot/indexer.js — polls factory + lockup wallets, parses v4.2.0/v4.1.0 events
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

// ── Event parser — v4.2.0 factory + v4.1.0 wallet opcodes ────────────────
function parseEvent(body) {
  // Защитная обёртка: если что-то сломается при парсинге — логируем и пропускаем,
  // чтобы индексатор никогда не падал на одном битом сообщении.
  try {
    if (!body || typeof body.beginParse !== 'function') return null;
    const s = body.beginParse();
    if (s.remainingBits < 32) return null;
    const op = s.loadUint(32);

    // ── Factory events (v4.2.0) ─────────────────────────────────────────
    if (op === 0x100) {
      // Читаем поля по одному. unlock_at может отсутствовать в некоторых
      // сборках — тогда оставляем 0, чтобы не падать на Index out of range.
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
    if (op === 0x109) return {
      type: 'JettonWalletSet',
      jetton_master: s.loadAddress().toString(),
      jetton_wallet: s.loadAddress().toString(),
    };
    if (op === 0x111) return {
      type: 'LockCreationFailed',
      lock_id: Number(s.loadUintBig(64)),
      creator: s.loadAddress().toString(),
      jetton: s.loadAddress().toString(),
      amount: s.loadCoins().toString(),
    };
    if (op === 0x112) return {
      type: 'CreateBounced',
      lock_id: Number(s.loadUintBig(64)),
      amount: s.loadCoins().toString(),
    };
    if (op === 0x115) return {
      type: 'RefundRequired',
      creator: s.loadAddress().toString(),
      jetton: s.loadAddress().toString(),
      amount: s.loadCoins().toString(),
    };

    // ── Wallet events (v4.1.0) ──────────────────────────────────────────
    if (op === 0x124) return {
      type: 'LockFunded',
      lock_id: Number(s.loadUintBig(64)),
      amount: s.loadCoins().toString(),
    };
    if (op === 0x125) return {
      type: 'Claimed',
      lock_id: Number(s.loadUintBig(64)),
      amount: s.loadCoins().toString(),
      beneficiary: s.loadAddress().toString(),
      beneficiary_wallet: s.loadAddress().toString(),
    };
    if (op === 0x126) return {
      type: 'ClaimBounced',
      lock_id: Number(s.loadUintBig(64)),
      amount: s.loadCoins().toString(),
    };

    return null;
  } catch (e) {
    console.error('PARSE FAIL ::', e.message);
    return null;
  }
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

    // Основной путь: вытащить параметры лока из StateInit child-кошелька,
    // который фабрика деплоит в этой же транзакции. Эти данные — источник
    // истины, они не зависят от того, что именно попало в event-log.
    let child = null;
    let initMeta = null;
    for (const msg of tx.outMessages.values()) {
      try {
        if (msg.info.type === 'internal' && msg.init && msg.info.dest) {
          child = msg.info.dest.toString();
          const d = msg.init.data.beginParse();
          initMeta = {
            lock_id:       Number(d.loadUintBig(64)),
            factory:       d.loadAddress().toString(),
            jetton_master: d.loadAddress().toString(),
            beneficiary:   d.loadAddress().toString(),
            creator:       d.loadAddress().toString(),
            amount:        d.loadCoins().toString(),
            unlock_at:     Number(d.loadUintBig(64)),
          };
        }
      } catch (e) {
        console.error('init parse skip:', e.message);
      }
    }

    if (initMeta && child) {
      const rec = { ...initMeta, type: 'LockCreated' };
      await db.insertLock({
        ...rec,
        jetton_master: rec.jetton_master,
        lockup_wallet: child,
        factory: FACTORY_ADDRESS,
      });
      await db.insertEvent({
        lock_id: rec.lock_id,
        event_type: 'LockCreated',
        event_data: rec,
        tx_hash: eventKey(FACTORY_ADDRESS, tx.lt, 'LockCreated'),
      });
      console.log('Indexed LockCreated #' + rec.lock_id, '->', child);
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
          if (ev.type === 'LockFunded') await db.markFunded(ev.lock_id);
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
