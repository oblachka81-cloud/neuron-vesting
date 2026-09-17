// bot/api.js — REST API: locks, whitelist, applications, admin, jetton icons (v5)
const db = require('./db');
const auth = require('./auth');
const { Cell } = require('@ton/core');

// ===== jetton icon resolver (server-side: no CORS problems, toncenter key used) =====
const iconCache = new Map();

function epFor(addr) {
  const main = addr.startsWith('EQ') || addr.startsWith('UQ') || addr.startsWith('Ef') || addr.startsWith('Uf');
  return main ? 'https://toncenter.com/api/v2/jsonRPC'
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
  const res = await fetch(epFor(master), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.TONCENTER_API_KEY ? { 'X-API-Key': process.env.TONCENTER_API_KEY } : {}),
    },
    body: JSON.stringify({
      id: '1', jsonrpc: '2.0', method: 'runGetMethod',
      params: { address: master, method: 'get_jetton_data', stack: [] },
    }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || 'toncenter error');
  const contentCell = Cell.fromBoc(Buffer.from(j.result.stack[3][1].bytes, 'base64'))[0];
  const cs = contentCell.beginParse();
  const prefix = cs.loadUint(8);
  if (prefix !== 0) throw new Error('on-chain metadata (prefix ' + prefix + ') not supported yet');
  let uri = readSnake(cs).trim();
  if (uri.startsWith('ipfs://')) uri = 'https://ipfs.io/ipfs/' + uri.slice(7);
  const mres = await fetch(uri);
  const mj = await mres.json();
  let image = mj.image || mj.image_url || null;
  if (image && image.startsWith('ipfs://')) image = 'https://ipfs.io/ipfs/' + image.slice(7);
  if (image) iconCache.set(master, { t: Date.now(), image });  // cache ONLY successes
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

// ===== routes =====
async function addRoutes(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  // ---- public ----
  if (path === '/api/stats' && req.method === 'GET') {
    try { return json(res, 200, await db.getStats()); }
    catch (e) { return json(res, 500, { error: e.message }); }
  }

  if (path === '/api/locks' && req.method === 'GET') {
    const wallet = url.searchParams.get('wallet');
    if (!wallet) return json(res, 400, { error: 'wallet param required' });
    try { return json(res, 200, { locks: await db.getLocks(wallet) }); }
    catch (e) { return json(res, 500, { error: e.message }); }
  }

  if (path === '/api/whitelist' && req.method === 'GET') {
    try { return json(res, 200, { whitelist: await db.listWhitelist() }); }
    catch (e) { return json(res, 500, { error: e.message }); }
  }

  const iconMatch = path.match(/^\/api\/jetton\/([^/]+)\/icon$/);
  if (iconMatch && req.method === 'GET') {
    try {
      const image = await getJettonIcon(decodeURIComponent(iconMatch[1]));
      return json(res, 200, { image });
    } catch (e) { return json(res, 200, { image: null }); }
  }

  // ---- applicant ----
  if (path === '/api/applications' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      if (!body.jetton_master || !body.applicant) {
        return json(res, 400, { error: 'jetton_master and applicant required' });
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
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  if (path.startsWith('/api/applications/status/') && req.method === 'GET') {
    const id = parseInt(path.split('/').pop(), 10);
    try {
      const row = await db.getApplication(id);
      if (!row) return json(res, 404, { error: 'not found' });
      return json(res, 200, { application: row });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // ---- admin: auth ----
  if (path === '/api/admin/login' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const session = await auth.login(body.passphrase || '');
      return json(res, 200, session);
    } catch (e) { return json(res, 401, { error: e.message }); }
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
    const s = await auth.requireAdmin(req, res); if (!s) return;
    const status = url.searchParams.get('status') || null;
    try { return json(res, 200, { applications: await db.listApplications(status) }); }
    catch (e) { return json(res, 500, { error: e.message }); }
  }

  if (path === '/api/admin/applications/approve' && req.method === 'POST') {
    const s = await auth.requireAdmin(req, res); if (!s) return;
    try {
      const body = JSON.parse(await readBody(req));
      const app = await db.getApplication(body.id);
      if (!app) return json(res, 404, { error: 'application not found' });
      await db.decideApplication(body.id, 'approved', body.reason || null, 'admin', body.due_diligence || {});
      await db.upsertWhitelist({
        jetton_master: app.jetton_master,
        name: body.name || null,
        symbol: body.symbol || null,
        description: body.description || null,
        applicant: app.applicant,
        metadata: body.metadata || {},
      });
      return json(res, 200, { ok: true, note: 'On-chain SetJettonWallet must be signed from treasury separately.' });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  if (path === '/api/admin/applications/reject' && req.method === 'POST') {
    const s = await auth.requireAdmin(req, res); if (!s) return;
    try {
      const body = JSON.parse(await readBody(req));
      await db.decideApplication(body.id, 'rejected', body.reason || null, 'admin', {});
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  if (path === '/api/admin/stats' && req.method === 'GET') {
    const s = await auth.requireAdmin(req, res); if (!s) return;
    try { return json(res, 200, await db.getStats()); }
    catch (e) { return json(res, 500, { error: e.message }); }
  }

  if (path === '/api/admin/events' && req.method === 'GET') {
    const s = await auth.requireAdmin(req, res); if (!s) return;
    try { return json(res, 200, { events: await db.listEvents(50) }); }
    catch (e) { return json(res, 500, { error: e.message }); }
  }

  return false;
}

module.exports = { addRoutes };
