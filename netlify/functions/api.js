'use strict';
const mongoose   = require('mongoose');
const jwt        = require('jsonwebtoken');
const { nanoid } = require('nanoid');
const https      = require('https');

// ── Env ──────────────────────────────────────────────────────
const MONGO_URI    = process.env.MONGO_URI    || '';
const ADMIN_PASS   = process.env.ADMIN_PASS   || '200520402459';
const JWT_SECRET   = process.env.JWT_SECRET   || 'astral_jwt_secret_2026';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO  = process.env.GITHUB_REPO  || 'Podda2006/ASTRAL_MD';
const GITHUB_ENTRY = process.env.GITHUB_ENTRY || 'start.js';

// ── MongoDB connection (reuse across warm invocations) ───────
let conn = null;
async function getDB() {
  if (conn && conn.readyState === 1) return conn;
  conn = await mongoose.connect(MONGO_URI, {
    useNewUrlParser: true, useUnifiedTopology: true,
    serverSelectionTimeoutMS: 5000,
  });
  return conn;
}

// ── Schema ───────────────────────────────────────────────────
const codeSchema = new mongoose.Schema({
  code:      { type: String, unique: true, required: true },
  used:      { type: Boolean, default: false },
  usedBy:    { type: String,  default: null },
  usedAt:    { type: Date,    default: null },
  note:      { type: String,  default: '' },
  createdAt: { type: Date,    default: Date.now },
});
const Code = mongoose.models.PremiumCode || mongoose.model('PremiumCode', codeSchema);

// ── JWT helpers ──────────────────────────────────────────────
function signToken()      { return jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '7d' }); }
function verifyToken(tok) {
  try { jwt.verify(tok, JWT_SECRET); return true; }
  catch { return false; }
}
function getToken(headers) {
  const auth = headers['authorization'] || headers['Authorization'] || '';
  return auth.replace('Bearer ', '').trim();
}

// ── CORS headers ─────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,PATCH,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

function ok(body, code=200)  { return { statusCode: code, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }; }
function err(msg, code=400)  { return { statusCode: code, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: msg }) }; }
function unauth()            { return err('Unauthorized', 401); }

// ── GitHub fetch helper ───────────────────────────────────────
function fetchGitHub(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'raw.githubusercontent.com',
      path,
      method: 'GET',
      headers: {
        'User-Agent': 'astral-runtime',
        ...(GITHUB_TOKEN ? { Authorization: `token ${GITHUB_TOKEN}` } : {}),
      },
    };
    https.get(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

// ════════════════════════════════════════════════════════════
//  MAIN HANDLER
// ════════════════════════════════════════════════════════════
exports.handler = async (event) => {
  const method = event.httpMethod;
  // path arrives as /api/login or /login depending on redirect
  const rawPath = event.path.replace('/.netlify/functions/api', '').replace('/api', '') || '/';
  const path    = rawPath || '/';

  // CORS preflight
  if (method === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}

  // ── PUBLIC: login ─────────────────────────────────────────
  if (path === '/login' && method === 'POST') {
    if (body.password !== ADMIN_PASS) return err('Invalid password', 401);
    return ok({ token: signToken() });
  }

  // ── PUBLIC: validate premium code (called by bot) ─────────
  if (path === '/validate' && method === 'POST') {
    const { code, ownerNumber } = body;
    if (!code || !ownerNumber) return err('Missing fields');
    try {
      await getDB();
      const entry = await Code.findOne({ code: code.trim().toUpperCase() });
      if (!entry) return ok({ valid: false, error: 'Code not found' });
      if (entry.used && entry.usedBy !== ownerNumber)
        return ok({ valid: false, error: 'Code already used' });
      if (!entry.used) {
        entry.used = true; entry.usedBy = ownerNumber; entry.usedAt = new Date();
        await entry.save();
      }
      return ok({ valid: true, message: 'Premium active' });
    } catch (e) { return err('Server error', 500); }
  }

  // ── PUBLIC: runtime meta (bot fetches entry from private repo) ──
  if (path === '/runtime/meta' && method === 'GET') {
    try {
      const content = await fetchGitHub(`/${GITHUB_REPO}/main/${GITHUB_ENTRY}`);
      return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Type': 'text/plain' },
        body: content,
      };
    } catch { return err('Runtime unavailable', 502); }
  }

  // ── ADMIN AUTH CHECK ──────────────────────────────────────
  const token = getToken(event.headers);
  if (!verifyToken(token)) return unauth();

  await getDB();

  // ── ADMIN: stats ──────────────────────────────────────────
  if (path === '/admin/stats' && method === 'GET') {
    const total  = await Code.countDocuments();
    const used   = await Code.countDocuments({ used: true });
    return ok({ total, used, unused: total - used });
  }

  // ── ADMIN: generate single code ───────────────────────────
  if (path === '/admin/generate' && method === 'POST') {
    const code = `ASTRAL-${nanoid(5).toUpperCase()}-${nanoid(5).toUpperCase()}`;
    await new Code({ code, note: body.note || '' }).save();
    return ok({ code, note: body.note || '' });
  }

  // ── ADMIN: generate bulk codes ────────────────────────────
  if (path === '/admin/generate-bulk' && method === 'POST') {
    const limit = Math.min(parseInt(body.count) || 5, 50);
    const codes = Array.from({ length: limit }, () => ({
      code: `ASTRAL-${nanoid(5).toUpperCase()}-${nanoid(5).toUpperCase()}`,
      note: body.note || '',
    }));
    await Code.insertMany(codes);
    return ok({ codes: codes.map(c => c.code), count: codes.length });
  }

  // ── ADMIN: list codes ─────────────────────────────────────
  if (path === '/admin/codes' && method === 'GET') {
    const f     = event.queryStringParameters?.filter || 'all';
    const query = f === 'used' ? { used: true } : f === 'unused' ? { used: false } : {};
    const codes = await Code.find(query).sort({ createdAt: -1 });
    return ok({ codes });
  }

  // ── ADMIN: delete code ────────────────────────────────────
  const delMatch = path.match(/^\/admin\/codes\/([A-Z0-9\-]+)$/);
  if (delMatch && method === 'DELETE') {
    await Code.deleteOne({ code: delMatch[1] });
    return ok({ success: true });
  }

  // ── ADMIN: reset code ─────────────────────────────────────
  const resetMatch = path.match(/^\/admin\/codes\/([A-Z0-9\-]+)\/reset$/);
  if (resetMatch && method === 'PATCH') {
    await Code.updateOne(
      { code: resetMatch[1] },
      { used: false, usedBy: null, usedAt: null }
    );
    return ok({ success: true });
  }

  return err('Not found', 404);
};
