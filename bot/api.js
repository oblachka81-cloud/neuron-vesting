// bot/api.js — REST API: locks, whitelist, applications, admin, jetton icons/meta/prices (v5.1.1)
const db = require('./db');
const auth = require('./auth');
const { Cell, Address, beginCell } = require('@ton/core');
const { TonClient } = require('@ton/ton');

let _tonClient = null;

function getTonClient() {
  if (!_tonClient) {
    const endpoint =
      process.env.NETWORK === 'testnet'
        ? 'https://testnet.toncenter.com/api/v2/jsonRPC'
        : 'https://toncenter.com/api/v2/jsonRPC';

    _tonClient = new TonClient({
      endpoint,
      apiKey: process.env.TONCENTER_API_KEY,
    });
  }
  return _tonClient;
}

// ===== Jetton metadata resolver (symbol / name / decimals from TonAPI) =====
const metaCache = new Map();

function safeDecimals(d) {
  const n = Number(d ?? 9);
  if (!Number.isFinite(n)) return 9;
  return Math.max(0, Math.min(18, Math.floor(n)));
}

async function fetchJettonMeta(master) {
  const hit = metaCache.get(master);
  if (hit && Date.now() - hit.t < 3600000) return hit;

  let addr = master;
  try {
    addr = Address.parse(master).toString({ urlSafe: true, bounceable: true });
  } catch (_) {}

  let symbol = null;
  let name = null;
  let decimals = 9;
  let image = null;

  try {
    const r = await fetch('https://tonapi.io/v2/jettons/' + encodeURIComponent(addr), {
      headers: process.env.TONAPI_KEY
        ? { Authorization: 'Bearer ' + process.env.TONAPI_KEY }
        : {},
    });

    if (r.ok) {
      const j = await r.json();
      const md = j.metadata || {};

      symbol = md.symbol || null;
      name = md.name || null;
      decimals = safeDecimals(md.decimals ?? j.decimals ?? null);
      image = md.image || j.preview || null;
    }
  } catch (e) {
    console.warn('fetchJettonMeta failed', master, e.message);
  }

  const rec = { t: Date.now(), symbol, name, decimals, image };

  metaCache.set(master, rec);
  metaCache.set(addr, rec);

  return rec;
}

// Monotonic treasury query_id. Date.now() alone collides on two calls in the
// same millisecond -> second multisig order refused by used_qids ("qid reused").
let _qidSeq = 0;
function nextQid() {
  return BigInt(Date.now()) * 1000n + BigInt(_qidSeq++);
}

// ===== Per-jetton price resolver (GeckoTerminal -> STON.fi -> null) =====
// GT is PRIMARY: it aggregates pools across all indexed DEX (STON.fi, DeDust,
// ...), so it covers tokens STON alone never sees. STON is the cheap backup
// (one batch call, no rate limit) and an independent second opinion. No
// liquidity gate, no phantom default: vesting is not a trading venue, the
// price is only a display multiplier. If neither source quotes a token we
// return null and the UI shows "—" rather than a fake number.
const COGNIQ_MASTER = 'EQDOjRZ5rbSnBBvhsv4g0JNN67p89617_2pNc_AO1dTEkaNg';
const PRICE_TTL = 300000; // 5 min
const priceCache = new Map(); // master -> { usd, source, t }

function normBounceable(master) {
  try { return Address.parse(master).toString({ urlSafe: true, bounceable: true }); }
  catch { return master; }
}
function normRaw(master) {
  try { return Address.parse(master).toRawString(); }
  catch { return master; }
}

// GT per master: prefer the most liquid pool's price for our token (base or
// quote). Falls back to the flat token attribute. Returns null if unresolvable
// (then STON picks it up). Field shapes are defensive so a GT schema change
// degrades to null instead of throwing.
async function gtPrice(master) {
  const raw = normRaw(master);
  const bounce = normBounceable(master);

  // (a) pools endpoint -> best pool -> base/quote price in USD
  try {
    const r = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/ton/tokens/${encodeURIComponent(bounce)}/pools`,
    );
    if (r.ok) {
      const j = await r.json();
      const pools = (j && j.data) || [];
      let best = null;
      let bestReserve = -1;
      for (const p of pools) {
        const a = p.attributes || {};
        const res = parseFloat(a.reserve_in_usd);
        if (Number.isFinite(res) && res > bestReserve) { bestReserve = res; best = p; }
      }
      if (best) {
        const a = best.attributes || {};
        const rel = best.relationships || {};
        const baseId = (rel.base_token && rel.base_token.data && rel.base_token.data.id) || '';
        const quoteId = (rel.quote_token && rel.quote_token.data && rel.quote_token.data.id) || '';
        const isBase = baseId.includes(raw) || baseId.includes(bounce);
        const isQuote = quoteId.includes(raw) || quoteId.includes(bounce);
        const cand = isBase ? a.base_token_price_usd : isQuote ? a.quote_token_price_usd : null;
        const n = cand != null ? parseFloat(cand) : null;
        if (n != null && Number.isFinite(n) && n > 0) return { usd: n, source: 'gt' };
      }
    }
  } catch (_) {}

  // (b) flat token attribute, if GT exposes it
  try {
    const r = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/ton/tokens/${encodeURIComponent(bounce)}`,
    );
    if (r.ok) {
      const j = await r.json();
      const p = j && j.data && j.data.attributes && j.data.attributes.price_usd;
      const n = p != null ? parseFloat(p) : null;
      if (n != null && Number.isFinite(n) && n > 0) return { usd: n, source: 'gt' };
    }
  } catch (_) {}

  return null;
}

// One STON.fi call, mapped onto every master still missing a price.
async function stonPrices(masters) {
  const out = new Map();
  if (masters.length === 0) return out;
  try {
    const res = await fetch('https://api.ston.fi/v1/assets');
    const data = await res.json();
    const list = data.asset_list || [];
    const byAddr = new Map();
    for (const a of list) if (a.contract_address) byAddr.set(a.contract_address, a);

    for (const m of masters) {
      const a = byAddr.get(normBounceable(m)) || byAddr.get(m);
      const p = a && a.dex_price_usd != null ? parseFloat(a.dex_price_usd) : null;
      if (p != null && Number.isFinite(p) && p > 0) out.set(m, { usd: p, source: 'ston' });
    }
  } catch (e) {
    console.warn('STON.fi price fetch failed', e.message);
  }
  return out;
}

async function getPrices(masters) {
  const now = Date.now();
  const out = new Map();
  const need = [];

  for (const m of masters) {
    const c = priceCache.get(m);
    if (c && now - c.t < PRICE_TTL) out.set(m, { usd: c.usd, source: c.source });
    else need.push(m);
  }

  if (need.length) {
    // GT primary, throttled to avoid burning the free-tier 30/min on warm-up.
    const gt = await mapLimit(need, 2, async (m) => [m, await gtPrice(m)]);
    const gtMap = new Map(gt);
    const missing = need.filter((m) => !gtMap.get(m));
    const ston = await stonPrices(missing); // cheap batch backup

    for (const m of need) {
      const rec = gtMap.get(m) || ston.get(m) || { usd: null, source: null };
      priceCache.set(m, { ...rec, t: now });
      out.set(m, rec);
    }
  }
  return out;
}

// ===== jetton icon resolver =====
const iconCache = new Map();

function epFor(addr) {
  const main =
    addr.startsWith('EQ') ||
    addr.startsWith('UQ') ||
    addr.startsWith('Ef') ||
    addr.startsWith('Uf');

  return main
    ? 'https://toncenter.com/api/v2/jsonRPC'
    : 'https://testnet.toncenter.com/api/v2/jsonRPC';
}

function readSnake(cs) {
  const bytes = [];
  let cur = cs;

  for (;;) {
    while (cur.remainingBits >= 8) bytes.push(cur.loadUint(8));
    if (cur.remainingRefs > 0) cur = cur.loadRef().beginParse();
    else break;
  }

  return Buffer.from(bytes).toString('utf8').replace(/\0+$/, '');
}

async function getJettonIcon(master) {
  const hit = iconCache.get(master);
  if (hit && Date.now() - hit.t < 3600000) return hit.image;

  let addr = master;
  try {
    addr = Address.parse(master).toString({ urlSafe: true, bounceable: true });
  } catch (_) {}

  const r = await fetch('https://tonapi.io/v2/jettons/' + encodeURIComponent(addr), {
    headers: process.env.TONAPI_KEY
      ? { Authorization: 'Bearer ' + process.env.TONAPI_KEY }
      : {},
  });

  if (!r.ok) throw new Error('tonapi ' + r.status);

  const j = await r.json();
  let image = (j.metadata && j.metadata.image) || j.preview || null;

  if (image && image.startsWith('ipfs://')) {
    image = 'https://ipfs.io/ipfs/' + image.slice(7);
  }

  if (!image) throw new Error('no image in metadata');

  iconCache.set(master, { t: Date.now(), image });
  iconCache.set(addr, { t: Date.now(), image });

  return image;
}

// ===== helpers =====
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Per-field length caps for untrusted public input (DoS / DB bloat guard).
const LIMITS = {
  applicant_name: 120,
  project_url: 512,
  notes: 2000,
  telegram_id: 64,
};

function overLimit(v, max) {
  return v != null && (typeof v !== 'string' || v.length > max);
}

function isAddr(s) {
  try {
    Address.parse(s);
    return true;
  } catch {
    return false;
  }
}

function uniqueStrings(arr) {
  return Array.from(new Set(arr.filter(Boolean).map(String)));
}

async function mapLimit(items, limit, fn) {
  const result = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      result[i] = await fn(items[i], i);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );

  return result;
}

async function attachDecimalsToLocks(locks) {
  const masters = uniqueStrings(locks.map((l) => l.jetton_master));
  const metas = await mapLimit(masters, 5, fetchJettonMeta);

  const byMaster = new Map();
  for (let i = 0; i < masters.length; i++) {
    byMaster.set(masters[i], metas[i]);
  }

  return locks.map((l) => ({
    ...l,
    decimals: safeDecimals(byMaster.get(String(l.jetton_master))?.decimals),
  }));
}

// ===== routes =====
async function addRoutes(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  // ---- public ----
  if (path === '/api/stats' && req.method === 'GET') {
    try {
      return json(res, 200, await db.getStats());
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  if (path === '/api/locks' && req.method === 'GET') {
    const wallet = url.searchParams.get('wallet');
    if (!wallet) return json(res, 400, { error: 'wallet param required' });

    try {
      const locks = await db.getLocks(wallet);
      const enriched = await attachDecimalsToLocks(locks);
      return json(res, 200, { locks: enriched });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  if (path === '/api/locks/public' && req.method === 'GET') {
    try {
      const summary = await db.getPublicVaultsSummary();
      const masters = uniqueStrings((summary?.by_jetton || []).map((x) => x.jetton_master));

      const priceMap = await getPrices(masters);
      const metaMap = new Map();
      await Promise.all(masters.map(async (m) => metaMap.set(m, await fetchJettonMeta(m))));

      const prices = {};
      for (const m of masters) {
        const pr = priceMap.get(m) || { usd: null, source: null };
        const md = metaMap.get(m);
        prices[m] = {
          usd: pr.usd,
          source: pr.source,
          decimals: safeDecimals(md?.decimals),
        };
      }

      // price_usd kept for backward compat with the old cabinet during the
      // deploy window; the new cabinet reads `prices` and this scalar can go.
      return json(res, 200, {
        summary,
        prices,
        price_usd: prices[COGNIQ_MASTER]?.usd ?? null,
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  if (path === '/api/locks/by-jetton' && req.method === 'GET') {
    const master = url.searchParams.get('master');
    if (!master) return json(res, 400, { error: 'master param required' });

    try {
      const locks = await db.getLocksByJetton(master);
      const meta = await fetchJettonMeta(master);
      const decimals = safeDecimals(meta.decimals);

      return json(res, 200, {
        locks: locks.map((l) => ({ ...l, decimals })),
        decimals,
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  if (path === '/api/whitelist' && req.method === 'GET') {
    try {
      return json(res, 200, { whitelist: await db.listWhitelist() });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  const metaMatch = path.match(/^\/api\/jetton\/([^/]+)\/meta$/);
  if (metaMatch && req.method === 'GET') {
    try {
      const master = decodeURIComponent(metaMatch[1]);
      const meta = await fetchJettonMeta(master);

      return json(res, 200, {
        symbol: meta.symbol,
        name: meta.name,
        decimals: meta.decimals,
      });
    } catch (e) {
      return json(res, 200, {
        symbol: null,
        name: null,
        decimals: 9,
        error: e.message,
      });
    }
  }

  const iconMatch = path.match(/^\/api\/jetton\/([^/]+)\/icon$/);
  if (iconMatch && req.method === 'GET') {
    try {
      const image = await getJettonIcon(decodeURIComponent(iconMatch[1]));
      return json(res, 200, { image });
    } catch (e) {
      return json(res, 200, { image: null, error: e.message });
    }
  }

  // ---- applicant ----
  if (path === '/api/applications' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));

      if (!body.jetton_master || !body.applicant) {
        return json(res, 400, { error: 'jetton_master and applicant required' });
      }

      // Validate addresses up front: a malformed master would otherwise sit in
      // the queue forever (approve throws on Address.parse and can't be cleared).
      if (!isAddr(body.jetton_master)) return json(res, 400, { error: 'invalid jetton_master' });
      if (!isAddr(body.applicant)) return json(res, 400, { error: 'invalid applicant' });

      // Reject absurdly long untrusted strings before they hit the DB.
      for (const k of Object.keys(LIMITS)) {
        if (overLimit(body[k], LIMITS[k])) return json(res, 400, { error: k + ' too long' });
      }

      const row = await db.insertApplication({
        jetton_master: body.jetton_master,
        applicant: body.applicant,
        telegram_id: body.telegram_id || null,
        applicant_name: body.applicant_name || null,
        project_url: body.project_url || null,
        notes: body.notes || null,
      });

      return json(res, 201, { application: row });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  if (path.startsWith('/api/applications/status/') && req.method === 'GET') {
    const id = parseInt(path.split('/').pop(), 10);

    try {
      const row = await db.getApplication(id);
      if (!row) return json(res, 404, { error: 'not found' });
      return json(res, 200, { application: row });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ---- admin: auth ----
  if (path === '/api/admin/login' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const session = await auth.login(body.passphrase || '');
      return json(res, 200, session);
    } catch (e) {
      return json(res, 401, { error: e.message });
    }
  }

  if (path === '/api/admin/me' && req.method === 'GET') {
    const s = await auth.requireAdmin(req, res);
    if (!s) return;
    return json(res, 200, { ok: true, expires_at: s.expires_at });
  }

  if (path === '/api/admin/logout' && req.method === 'POST') {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    await auth.logout(token);
    return json(res, 200, { ok: true });
  }

  // ---- admin: data ----
  if (path === '/api/admin/applications' && req.method === 'GET') {
    const s = await auth.requireAdmin(req, res);
    if (!s) return;

    const status = url.searchParams.get('status') || null;

    try {
      return json(res, 200, { applications: await db.listApplications(status) });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  if (path === '/api/admin/applications/approve' && req.method === 'POST') {
    const s = await auth.requireAdmin(req, res);
    if (!s) return;

    try {
      const body = JSON.parse(await readBody(req));
      const app = await db.getApplication(body.id);
      if (!app) return json(res, 404, { error: 'application not found' });

      if (!isAddr(app.jetton_master)) {
        return json(res, 500, { error: 'invalid jetton_master in application' });
      }

      // Resolve jetton metadata (symbol / name) from TonAPI if not given.
      let symbol = body.symbol || null;
      let name = body.name || null;

      if (!symbol || !name) {
        const meta = await fetchJettonMeta(app.jetton_master);
        symbol = symbol || meta.symbol;
        name = name || meta.name;
      }

      // 1. DB approve + whitelist upsert (with resolved metadata)
      await db.decideApplication(
        body.id,
        'approved',
        body.reason || null,
        'admin',
        body.due_diligence || {},
      );

      await db.upsertWhitelist({
        jetton_master: app.jetton_master,
        name: name,
        symbol: symbol,
        description: body.description || null,
        applicant: app.applicant,
        metadata: body.metadata || {},
      });

      // 2. Prepare on-chain SetJettonWallet body for multisig.
      const factoryStr = process.env.FACTORY_ADDRESS;
      if (!factoryStr) {
        return json(res, 500, { error: 'FACTORY_ADDRESS not configured' });
      }

      const FACTORY = Address.parse(factoryStr);
      const master = Address.parse(app.jetton_master);
      const client = getTonClient();

      const res1 = await client.runMethod(master, 'get_wallet_address', [
        { type: 'slice', cell: beginCell().storeAddress(FACTORY).endCell() },
      ]);

      const factoryJW = res1.stack.readCell().beginParse().loadAddress();

      const qid = nextQid();

      const txBody = beginCell()
        .storeUint(0x21, 32)
        .storeUint(qid, 64)
        .storeAddress(master)
        .storeAddress(factoryJW)
        .endCell();

      return json(res, 200, {
        ok: true,
        note: 'Sign on-chain via multisig.ton.org (2-of-3)',
        multisig: {
          target: FACTORY.toString(),
          value: '0.1',
          query_id: qid.toString(),
          jetton_master: master.toString(),
          factory_jetton_wallet: factoryJW.toString(),
          body_base64: txBody.toBoc().toString('base64'),
        },
        resolved: { symbol, name },
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  if (path === '/api/admin/applications/reject' && req.method === 'POST') {
    const s = await auth.requireAdmin(req, res);
    if (!s) return;

    try {
      const body = JSON.parse(await readBody(req));
      await db.decideApplication(body.id, 'rejected', body.reason || null, 'admin', {});
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  if (path === '/api/admin/stats' && req.method === 'GET') {
    const s = await auth.requireAdmin(req, res);
    if (!s) return;

    try {
      return json(res, 200, await db.getStats());
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  if (path === '/api/admin/events' && req.method === 'GET') {
    const s = await auth.requireAdmin(req, res);
    if (!s) return;

    try {
      return json(res, 200, { events: await db.listEvents(50) });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  return false;
}

module.exports = { addRoutes };
