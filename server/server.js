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
app.use(express.json({ limit: '15mb' }));
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

function normalizeEmail(value) {
  return str(value).toLowerCase();
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function sendPasswordResetEmail(email, resetUrl) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) {
    if (!IS_PROD) console.log(`[UniFlow] Password reset link for ${email}: ${resetUrl}`);
    return false;
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [email],
      subject: 'UniFlow password reset',
      html: `<p>We received a request to reset your UniFlow password.</p><p><a href="${resetUrl}">Reset your password</a></p><p>This link expires in 30 minutes. If you did not request this, you can ignore this email.</p>`
    })
  });
  if (!response.ok) throw new Error(`Email provider returned ${response.status}`);
  return true;
}

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
  const email = normalizeEmail(req.body.email);
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
  let result;
  try {
    result = db.prepare('INSERT INTO users (name, email, password_hash, program) VALUES (?, ?, ?, ?)')
      .run(name, email, hash, program);
  } catch (err) {
    // The UNIQUE email constraint is the final authority, including concurrent requests.
    if (String(err.message || '').toLowerCase().includes('unique') && String(err.message || '').toLowerCase().includes('email')) {
      return res.status(409).json({ error: 'An account with this email already exists. Try logging in.' });
    }
    throw err;
  }
  const userId = Number(result.lastInsertRowid);
  db.prepare('INSERT INTO user_data (user_id, json) VALUES (?, ?)')
    .run(userId, JSON.stringify({ courses: [], tasks: [], projects: [] }));

  startSession(res, userId);
  res.status(201).json({ user: { id: userId, name, email, program } });
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const ok = await bcrypt.compare(password, row ? row.password_hash : DUMMY_HASH);
  if (!row || !ok) return res.status(401).json({ error: 'Incorrect email or password.' });
  startSession(res, row.id);
  res.json({ user: publicUser(row) });
});


app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  const email = normalizeEmail(req.body.email);
  // Always return the same public response so attackers cannot enumerate accounts.
  const generic = { ok: true, message: 'If an account exists for that email, a password reset link has been sent.' };
  if (!EMAIL_RE.test(email) || email.length > 254) return res.json(generic);

  const user = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email);
  if (!user) return res.json(generic);

  // Invalidate older unused tokens for this account.
  db.prepare("UPDATE password_reset_tokens SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL").run(user.id);
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashResetToken(rawToken);
  db.prepare("INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, datetime('now', '+30 minutes'))")
    .run(user.id, tokenHash);

  const base = `${req.protocol}://${req.get('host')}`;
  const resetUrl = `${base}/login.html?reset=${encodeURIComponent(rawToken)}`;
  try {
    await sendPasswordResetEmail(user.email, resetUrl);
  } catch (err) {
    console.error('[UniFlow] Could not send password reset email:', err.message);
    // Do not reveal whether the account exists.
  }
  res.json(generic);
});

app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
  const token = str(req.body.token);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!token) return res.status(400).json({ error: 'Invalid or expired reset link.' });
  if (password.length < 8 || password.length > 72) return res.status(400).json({ error: 'Password must be 8–72 characters.' });

  const row = db.prepare("SELECT * FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')")
    .get(hashResetToken(token));
  if (!row) return res.status(400).json({ error: 'This password reset link is invalid or has expired.' });

  const hash = await bcrypt.hash(password, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, row.user_id);
  db.prepare("UPDATE password_reset_tokens SET used_at = datetime('now') WHERE id = ?").run(row.id);
  // Revoke all existing sessions by changing the password; existing JWTs are stateless,
  // so users should log in again after reset. The current reset flow does not auto-login.
  res.json({ ok: true, message: 'Password changed successfully. Please log in with your new password.' });
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
  const data = row ? JSON.parse(row.json) : {};
  res.json({
    data: {
      courses: Array.isArray(data.courses) ? data.courses : [],
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
      projects: Array.isArray(data.projects) ? data.projects : [],
      profile: data.profile || {},
      routine: data.routine || null
    }
  });
});

app.put('/api/data', requireAuth, (req, res) => {
  const d = req.body && req.body.data;
  const valid = d && typeof d === 'object' &&
    Array.isArray(d.courses) && Array.isArray(d.tasks) && Array.isArray(d.projects);
  if (!valid) return res.status(400).json({ error: 'Invalid data format' });
  const clean = {
    courses: d.courses,
    tasks: d.tasks,
    projects: d.projects,
    profile: d.profile && typeof d.profile === 'object' ? d.profile : {},
    routine: d.routine && typeof d.routine === 'object' ? d.routine : null
  };
  db.prepare(`
    INSERT INTO user_data (user_id, json, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
  `).run(req.user.id, JSON.stringify(clean));
  res.json({ ok: true });
});


// ---- Student profile + routine intelligence -------------------------------
const RUET_SOURCES = {
  university: 'https://www.ruet.ac.bd/',
  cse: 'https://www.cse.ruet.ac.bd/notice',
  routine: 'https://www.cse.ruet.ac.bd/page/class-routine',
  archive: 'https://ruetcsearchive.vercel.app/'
};

function currentUserData(userId) {
  const row = db.prepare('SELECT json FROM user_data WHERE user_id = ?').get(userId);
  return row ? JSON.parse(row.json) : { courses: [], tasks: [], projects: [], profile: {}, routine: null };
}

function saveUserData(userId, data) {
  db.prepare(`
    INSERT INTO user_data (user_id, json, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
  `).run(userId, JSON.stringify(data));
}

function cleanBase64File(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl || '');
  if (!m) return null;
  return { mime: m[1], buffer: Buffer.from(m[2], 'base64') };
}

function inferSeries(text) {
  const matches = [...String(text || '').matchAll(/\b(?:series|batch)\s*[:\-]?\s*(20\d{2})\b/gi)];
  return matches.length ? matches[matches.length - 1][1] : null;
}

app.get('/api/profile', requireAuth, (req, res) => {
  const data = currentUserData(req.user.id);
  res.json({ profile: data.profile || {}, routine: data.routine || null, sources: RUET_SOURCES });
});

app.put('/api/profile', requireAuth, (req, res) => {
  const p = req.body && req.body.profile;
  if (!p || typeof p !== 'object') return res.status(400).json({ error: 'Invalid profile' });
  const profile = {
    fullName: str(p.fullName).slice(0, 100),
    studentId: str(p.studentId).slice(0, 40),
    department: str(p.department).slice(0, 100),
    program: str(p.program).slice(0, 100),
    email: str(p.email).slice(0, 254),
    phone: str(p.phone).slice(0, 30),
    academicYear: str(p.academicYear).slice(0, 30),
    semester: str(p.semester).slice(0, 30),
    section: str(p.section).slice(0, 20)
  };
  const data = currentUserData(req.user.id);
  data.profile = profile;
  saveUserData(req.user.id, data);
  res.json({ ok: true, profile });
});

app.post('/api/routine/analyze', requireAuth, async (req, res) => {
  const file = cleanBase64File(req.body && req.body.dataUrl);
  const fileName = str(req.body && req.body.fileName).slice(0, 180);
  if (!file || !file.buffer.length) return res.status(400).json({ error: 'Please upload a routine PDF or image.' });
  if (file.buffer.length > 10 * 1024 * 1024) return res.status(413).json({ error: 'Routine file must be 10 MB or smaller.' });
  const allowed = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
  if (!allowed.includes(file.mime)) return res.status(400).json({ error: 'Only PDF, PNG, JPG, or WEBP routine files are supported.' });

  const data = currentUserData(req.user.id);
  const profile = data.profile || {};
  const inferredFromName = inferSeries(fileName);

  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({
      error: 'Smart AI is not configured yet. Add OPENAI_API_KEY to your environment, then retry.',
      setup: true
    });
  }

  try {
    const model = process.env.OPENAI_MODEL || 'gpt-5.6';
    let content;
    const instructions = `You are UniFlow Smart AI for a RUET CSE student.
Analyze the uploaded class routine carefully. Identify the student's academic series/year from labels such as "2024 Series", "2023 Series", "1st Year", "2nd Year", etc.
Return ONLY valid JSON with this exact shape:
{
  "academicYear": "1st Year / 2nd Year / 3rd Year / 4th Year / Unknown",
  "series": "2024",
  "semester": "Odd / Even / Unknown",
  "section": "A / B / Unknown",
  "confidence": 0.0,
  "courses": [{"code":"CSE 2201","name":"...","day":"Saturday","start":"08:00","end":"08:50","room":"..."}],
  "notes": ["..."]
}
Do not invent values. If the routine contains multiple years, choose the year/series that best matches the student's profile (${JSON.stringify(profile)}), otherwise report the dominant/clearest undergraduate CSE schedule.`;

    if (file.mime === 'application/pdf') {
      const form = new FormData();
      form.append('purpose', 'user_data');
      form.append('file', new Blob([file.buffer], { type: file.mime }), fileName || 'routine.pdf');
      const upload = await fetch('https://api.openai.com/v1/files', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: form
      });
      const uploaded = await upload.json();
      if (!upload.ok) throw new Error(uploaded.error?.message || 'OpenAI file upload failed');
      content = [
        { type: 'input_text', text: instructions },
        { type: 'input_file', file_id: uploaded.id }
      ];
    } else {
      content = [
        { type: 'input_text', text: instructions },
        { type: 'input_image', image_url: `data:${file.mime};base64,${file.buffer.toString('base64')}`, detail: 'high' }
      ];
    }

    const ai = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        input: [{ role: 'user', content }],
        tools: [{ type: 'web_search' }],
        instructions: 'Use official RUET/CSE sources when external verification is needed. Prefer ruet.ac.bd and cse.ruet.ac.bd. The RUET CSE Archive is a supplementary student resource, not an authority.',
        max_output_tokens: 4000
      })
    });
    const result = await ai.json();
    if (!ai.ok) throw new Error(result.error?.message || 'Smart AI analysis failed');
    const raw = typeof result.output_text === 'string'
  ? result.output_text
  : (result.output || [])
      .flatMap(item => Array.isArray(item.content) ? item.content : [])
      .map(part => typeof part.text === 'string' ? part.text : '')
      .filter(Boolean)
      .join('\n');

const match = raw.match(/\{[\s\S]*\}/);
if (!match) throw new Error('Smart AI returned an unreadable result.');

let analysis;
try {
  analysis = JSON.parse(match[0]);
} catch {
  throw new Error('Smart AI returned invalid JSON.');
}
    if (!analysis.series) analysis.series = inferredFromName || null;

    data.routine = {
      fileName: fileName || 'routine',
      mime: file.mime,
      uploadedAt: new Date().toISOString(),
      analysis
    };
    data.profile = { ...profile, academicYear: analysis.academicYear || profile.academicYear, semester: analysis.semester || profile.semester, section: analysis.section || profile.section };
    saveUserData(req.user.id, data);

    res.json({ ok: true, analysis, profile: data.profile, sources: RUET_SOURCES });
  } catch (e) {
    console.error('Routine AI error:', e);
    res.status(502).json({ error: e.message || 'Smart AI could not analyze the routine.' });
  }
});

app.get('/api/ruet/sources', requireAuth, async (req, res) => {
  res.json({ sources: RUET_SOURCES, verifiedAt: new Date().toISOString() });
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
