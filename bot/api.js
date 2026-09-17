// bot/api.js — REST API for locks + whitelist + admin panel (v4)
const db = require('./db');
const auth = require('./auth');

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

async function addRoutes(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  // ==== Public endpoints ====

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

  // ==== Applicant endpoints (public: submit an application, check status) ====

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

  // ==== Admin: auth ====

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

  // ==== Admin: applications ====

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
      return json(res, 200, { ok: true, note: 'On-chain whitelist SetJettonWallet must be signed from treasury separately.' });
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

  // ==== Admin: fees & stats ====

  if (path === '/api/admin/stats' && req.method === 'GET') {
    const s = await auth.requireAdmin(req, res); if (!s) return;
    try { return json(res, 200, await db.getStats()); }
    catch (e) { return json(res, 500, { error: e.message }); }
  }

  return false;
}

module.exports = { addRoutes };
