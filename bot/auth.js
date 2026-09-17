// bot/auth.js — admin session management (passphrase + HMAC-signed token)
const crypto = require('crypto');
const db = require('./db');

const PASSPHRASE = (process.env.ADMIN_PASSPHRASE || '').trim();
const SECRET = (process.env.ADMIN_SECRET || '').trim();
const SESSION_TTL_HOURS = 12;

if (!PASSPHRASE) console.warn('WARN: ADMIN_PASSPHRASE not set — admin login disabled');
if (!SECRET) console.warn('WARN: ADMIN_SECRET not set — using insecure fallback (set it in env!)');

const hashPass = (p) => crypto.createHash('sha256').update(SECRET + '::' + p).digest('hex');

async function login(passphrase) {
  if (!PASSPHRASE) throw new Error('Admin login not configured');
  if (passphrase !== PASSPHRASE) throw new Error('invalid passphrase');
  const token = crypto.randomBytes(32).toString('hex');
  const sig = crypto.createHmac('sha256', SECRET || 'fallback').update(token).digest('hex');
  const full = token + '.' + sig;
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000).toISOString();
  await db.createSession(full, expiresAt);
  return { token: full, expires_at: expiresAt };
}

async function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const [raw, sig] = token.split('.');
  if (!raw || !sig) return null;
  const expected = crypto.createHmac('sha256', SECRET || 'fallback').update(raw).digest('hex');
  if (expected !== sig) return null;
  const row = await db.getSession(token);
  return row ? { token, expires_at: row.expires_at } : null;
}

async function logout(token) {
  try { await db.deleteSession(token); } catch {}
}

async function requireAdmin(req, res) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const session = await verify(token);
  if (!session) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return null;
  }
  return session;
}

module.exports = { login, verify, logout, requireAdmin };
