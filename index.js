'use strict';
const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const { nanoid } = require('nanoid');
const path       = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── MongoDB ─────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('[ASTRAL] MongoDB connected'))
  .catch(e => console.error('[ASTRAL] MongoDB error:', e.message));

// ── Schemas ─────────────────────────────────────────────────
const codeSchema = new mongoose.Schema({
  code:       { type: String, unique: true, required: true },
  used:       { type: Boolean, default: false },
  usedBy:     { type: String, default: null },   // OWNER_NUMBER
  usedAt:     { type: Date,   default: null },
  note:       { type: String, default: '' },     // admin note (e.g. user name)
  createdAt:  { type: Date,   default: Date.now },
});
const Code = mongoose.model('PremiumCode', codeSchema);

// ── JWT Auth ─────────────────────────────────────────────────
const ADMIN_PASS = process.env.ADMIN_PASS || '200520402459';
const JWT_SECRET = process.env.JWT_SECRET || 'astral_jwt_super_secret_2026';

function authMiddleware(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ══════════════════════════════════════════════════════════════
//  PUBLIC ROUTES
// ══════════════════════════════════════════════════════════════

// Admin login
app.post('/api/login', async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASS) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token });
});

// ── Bot validate (called by client bot silently) ─────────────
app.post('/api/validate', async (req, res) => {
  const { code, ownerNumber } = req.body;
  if (!code || !ownerNumber) {
    return res.status(400).json({ valid: false, error: 'Missing fields' });
  }
  try {
    const entry = await Code.findOne({ code: code.trim().toUpperCase() });
    if (!entry) return res.json({ valid: false, error: 'Code not found' });
    if (entry.used && entry.usedBy !== ownerNumber) {
      return res.json({ valid: false, error: 'Code already used by another user' });
    }
    // First time use — bind to this owner
    if (!entry.used) {
      entry.used    = true;
      entry.usedBy  = ownerNumber;
      entry.usedAt  = new Date();
      await entry.save();
    }
    return res.json({ valid: true, message: 'Premium active' });
  } catch (e) {
    res.status(500).json({ valid: false, error: 'Server error' });
  }
});

// ══════════════════════════════════════════════════════════════
//  ADMIN ROUTES (JWT protected)
// ══════════════════════════════════════════════════════════════

// Generate single code
app.post('/api/admin/generate', authMiddleware, async (req, res) => {
  const { note } = req.body;
  const code = `ASTRAL-${nanoid(5).toUpperCase()}-${nanoid(5).toUpperCase()}`;
  try {
    const entry = new Code({ code, note: note || '' });
    await entry.save();
    res.json({ code, note });
  } catch (e) {
    res.status(500).json({ error: 'Generate failed' });
  }
});

// Generate bulk codes
app.post('/api/admin/generate-bulk', authMiddleware, async (req, res) => {
  const { count = 5, note = '' } = req.body;
  const limit = Math.min(parseInt(count), 50);
  const codes = [];
  for (let i = 0; i < limit; i++) {
    codes.push({ code: `ASTRAL-${nanoid(5).toUpperCase()}-${nanoid(5).toUpperCase()}`, note });
  }
  try {
    await Code.insertMany(codes);
    res.json({ codes: codes.map(c => c.code), count: codes.length });
  } catch (e) {
    res.status(500).json({ error: 'Bulk generate failed' });
  }
});

// List all codes
app.get('/api/admin/codes', authMiddleware, async (req, res) => {
  const { filter } = req.query; // all | used | unused
  const query = filter === 'used' ? { used: true } : filter === 'unused' ? { used: false } : {};
  const codes = await Code.find(query).sort({ createdAt: -1 });
  res.json({ codes });
});

// Revoke (delete) a code
app.delete('/api/admin/codes/:code', authMiddleware, async (req, res) => {
  await Code.deleteOne({ code: req.params.code.toUpperCase() });
  res.json({ success: true });
});

// Reset a used code (make it usable again)
app.patch('/api/admin/codes/:code/reset', authMiddleware, async (req, res) => {
  await Code.updateOne(
    { code: req.params.code.toUpperCase() },
    { used: false, usedBy: null, usedAt: null }
  );
  res.json({ success: true });
});

// Stats
app.get('/api/admin/stats', authMiddleware, async (req, res) => {
  const total  = await Code.countDocuments();
  const used   = await Code.countDocuments({ used: true });
  const unused = total - used;
  res.json({ total, used, unused });
});


// ── ADMIN: delete code ────────────────────────────────────────
app.delete('/api/admin/codes/:code', authMiddleware, async (req, res) => {
  await Code.deleteOne({ code: req.params.code.toUpperCase() });
  res.json({ success: true });
});

// ── ADMIN: reset code ─────────────────────────────────────────
app.patch('/api/admin/codes/:code/reset', authMiddleware, async (req, res) => {
  await Code.updateOne(
    { code: req.params.code.toUpperCase() },
    { used: false, usedBy: null, usedAt: null }
  );
  res.json({ success: true });
});

// ── RUNTIME PROXY — serves bot entry from private GitHub ──────
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN  || '';
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'Podda2006/ASTRAL_MD';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_ENTRY  = process.env.GITHUB_ENTRY  || 'start.js';

app.get('/api/runtime/meta', async (req, res) => {
  const rawUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${GITHUB_ENTRY}`;
  try {
    const ghRes = await fetch(rawUrl, {
      headers: GITHUB_TOKEN ? { Authorization: `token ${GITHUB_TOKEN}` } : {}
    });
    if (!ghRes.ok) return res.status(502).json({ error: 'Runtime unavailable' });
    const content = await ghRes.text();
    res.setHeader('Content-Type', 'text/plain');
    res.send(content);
  } catch {
    res.status(502).json({ error: 'Fetch failed' });
  }
});

// ── Catch-all → serve frontend ───────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[ASTRAL PREMIUM] Running on port ${PORT}`));

module.exports = app;

