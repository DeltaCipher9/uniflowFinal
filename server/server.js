// server.js - the UniFlow backend.
// Serves the website (public/ folder) AND the API (/api/...) from one address,
// so you only run one thing:  npm start  ->  http://localhost:3000
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const COOKIE_NAME = 'uniflow_token';
const SESSION_DAYS = 7;

// ---- Secret used to sign login tokens. Created once and saved, so logins survive restarts.
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(__dirname, '..', 'data', 'jwt-secret.txt');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}
const JWT_SECRET = loadSecret();

const app = express();
// Render and other reverse proxies forward the original client IP/HTTPS state.
// Trust one proxy so secure cookies and rate limiting work correctly in production.
if (IS_PROD) app.set('trust proxy', 1);
// CSP is off because the existing pages use inline onclick="..." handlers (see README).
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// ---- Helpers --------------------------------------------------------------
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10); // keeps login timing equal for unknown emails

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, program: u.program };
}

function startSession(res, userId) {
  const token = jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,            // JavaScript in the page can't read it (protects from XSS theft)
    sameSite: 'lax',           // not sent on cross-site POSTs (basic CSRF protection)
    secure: IS_PROD,           // HTTPS only when deployed
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
  });
}

function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    const { uid } = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id, name, email, program FROM users WHERE id = ?').get(uid);
    if (!user) return res.status(401).json({ error: 'Account no longer exists' });
    req.user = user;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Session expired, please log in again' });
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const str = (v) => (typeof v === 'string' ? v.trim() : '');

// ---- Auth routes ----------------------------------------------------------
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const name = str(req.body.name);
  const email = str(req.body.email).toLowerCase();
  const program = str(req.body.program).slice(0, 100);
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  if (name.length < 1 || name.length > 80) return res.status(400).json({ error: 'Please enter your name (max 80 characters).' });
  if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (password.length > 72) return res.status(400).json({ error: 'Password must be at most 72 characters.' });

  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'An account with this email already exists. Try logging in.' });
  }

  const hash = await bcrypt.hash(password, 12);
  const result = db.prepare('INSERT INTO users (name, email, password_hash, program) VALUES (?, ?, ?, ?)')
    .run(name, email, hash, program);
  const userId = Number(result.lastInsertRowid);
  db.prepare('INSERT INTO user_data (user_id, json) VALUES (?, ?)')
    .run(userId, JSON.stringify({ courses: [], tasks: [], projects: [] }));

  startSession(res, userId);
  res.status(201).json({ user: { id: userId, name, email, program } });
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const email = str(req.body.email).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const ok = await bcrypt.compare(password, row ? row.password_hash : DUMMY_HASH);
  if (!row || !ok) return res.status(401).json({ error: 'Incorrect email or password.' });
  startSession(res, row.id);
  res.json({ user: publicUser(row) });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ---- Per-user data routes -------------------------------------------------
app.get('/api/data', requireAuth, (req, res) => {
  const row = db.prepare('SELECT json FROM user_data WHERE user_id = ?').get(req.user.id);
  res.json({ data: row ? JSON.parse(row.json) : { courses: [], tasks: [], projects: [] } });
});

app.put('/api/data', requireAuth, (req, res) => {
  const d = req.body && req.body.data;
  const valid = d && typeof d === 'object' &&
    Array.isArray(d.courses) && Array.isArray(d.tasks) && Array.isArray(d.projects);
  if (!valid) return res.status(400).json({ error: 'Invalid data format' });
  // Only keep the three known lists, nothing else.
  const clean = { courses: d.courses, tasks: d.tasks, projects: d.projects };
  db.prepare(`
    INSERT INTO user_data (user_id, json, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
  `).run(req.user.id, JSON.stringify(clean));
  res.json({ ok: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Hosting/platform health check.
app.get('/health', (req, res) => res.status(200).json({ ok: true, service: 'UniFlow' }));

// Public landing page for search engines and first-time visitors.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'landing.html'));
});

// ---- Website files --------------------------------------------------------
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- Errors ---------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.status === 413 ? 'Data too large' : 'Server error' });
});

app.listen(PORT, () => {
  console.log(`\n  UniFlow is running ->  http://localhost:${PORT}\n`);
});
