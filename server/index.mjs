import dotenv from 'dotenv';
import cors from 'cors';
import express from 'express';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { randomBytes, randomUUID } from 'crypto';
import nodemailer from 'nodemailer';
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const PORT = Number(process.env.PORT) || 3456;
/** Bind on all interfaces so a cloud VM accepts traffic (use 127.0.0.1 only for local lock-down). */
const HOST = process.env.HOST?.trim() || '0.0.0.0';
const DATABASE_URL = process.env.DATABASE_URL?.trim();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-set-JWT_SECRET-in-production';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d';
/** Public site URL for verification links (no trailing slash), e.g. https://daily-checklist-tracker.onrender.com */
const FRONTEND_URL = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
const VERIFY_TOKEN_BYTES = 32;
const VERIFY_EXPIRY_HOURS = Number(process.env.VERIFY_EXPIRY_HOURS) || 48;

/** @type {pg.Pool} */
let pool;

function buildPgPool() {
  const ssl =
    DATABASE_URL.includes('sslmode=require') || DATABASE_URL.includes('neon.tech')
      ? { rejectUnauthorized: true }
      : undefined;
  return new pg.Pool({ connectionString: DATABASE_URL, ssl });
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function validateV2(body) {
  return (
    body &&
    body.version === 2 &&
    Array.isArray(body.byWeekday) &&
    body.byWeekday.length === 7 &&
    Array.isArray(body.doneKeys)
  );
}

function validateV3(body) {
  if (!body || body.version !== 3 || !Array.isArray(body.activities) || !Array.isArray(body.doneKeys)) {
    return false;
  }
  for (const a of body.activities) {
    if (!a || typeof a !== 'object') return false;
    if (typeof a.id !== 'string' || typeof a.name !== 'string') return false;
    if (typeof a.weekdayIndex !== 'number' || a.weekdayIndex < 0 || a.weekdayIndex > 6) return false;
    if (typeof a.effectiveFrom !== 'string' || !YMD.test(a.effectiveFrom)) return false;
    if (a.effectiveTo != null && (typeof a.effectiveTo !== 'string' || !YMD.test(a.effectiveTo))) return false;
    if (typeof a.sortOrder !== 'number') return false;
    const sup = a.suppressWeeklyActivityId;
    if (sup != null) {
      if (typeof sup !== 'string' || !sup) return false;
      if (typeof a.oneDayDate !== 'string' || !YMD.test(a.oneDayDate)) return false;
      if (a.effectiveFrom !== a.oneDayDate || a.effectiveTo !== a.oneDayDate) return false;
      if (typeof a.name !== 'string') return false;
    } else if (typeof a.oneDayDate === 'string') {
      if (!YMD.test(a.oneDayDate)) return false;
      if (a.effectiveFrom !== a.oneDayDate || a.effectiveTo !== a.oneDayDate) return false;
      if (typeof a.name !== 'string' || !a.name.trim()) return false;
    } else if (a.oneDayDate != null) {
      return false;
    } else if (typeof a.name !== 'string' || !a.name.trim()) {
      return false;
    }
  }
  return true;
}

function activityIdSet(activities) {
  const s = new Set();
  for (const a of activities) {
    if (a && typeof a.id === 'string') s.add(a.id);
  }
  return s;
}

/** @returns {{ activities: object[], doneKeys: string[] } | null} */
function normalizeRoutineBody(body) {
  if (validateV3(body)) {
    return { activities: body.activities, doneKeys: body.doneKeys };
  }
  if (validateV2(body)) {
    const activities = [];
    for (let w = 0; w < 7; w++) {
      let i = 0;
      for (const a of body.byWeekday[w] || []) {
        if (a && typeof a.id === 'string' && typeof a.name === 'string') {
          activities.push({
            id: a.id,
            name: a.name,
            weekdayIndex: w,
            oneDayDate: null,
            effectiveFrom: '2000-01-01',
            effectiveTo: null,
            sortOrder: i++,
          });
        }
      }
    }
    return { activities, doneKeys: body.doneKeys };
  }
  return null;
}

function requireAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const token = h.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

function signToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS activities (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      weekday_index INTEGER NOT NULL CHECK (weekday_index >= 0 AND weekday_index <= 6),
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      effective_from TEXT NOT NULL DEFAULT '2000-01-01',
      effective_to TEXT,
      one_day_date TEXT,
      suppress_weekly_activity_id TEXT,
      PRIMARY KEY (user_id, id)
    );
    CREATE TABLE IF NOT EXISTS completions (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date_key TEXT NOT NULL,
      activity_id TEXT NOT NULL,
      PRIMARY KEY (user_id, date_key, activity_id),
      FOREIGN KEY (user_id, activity_id) REFERENCES activities(user_id, id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS pending_registrations (
      email TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function getMailTransport() {
  const host = process.env.SMTP_HOST?.trim();
  if (!host) return null;
  const user = (process.env.SMTP_USER ?? '').trim();
  const pass = (process.env.SMTP_PASS ?? '').trim();
  if (user && !pass && process.env.NODE_ENV !== 'production') {
    console.warn('[email] SMTP_USER is set but SMTP_PASS is empty — Gmail needs an app password in SMTP_PASS.');
  }
  return nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true' || process.env.SMTP_SECURE === '1',
    auth: user ? { user, pass } : undefined,
  });
}

async function sendVerificationEmail(toEmail, token) {
  const verifyPath = `/verify-email?token=${encodeURIComponent(token)}`;
  const link = FRONTEND_URL ? `${FRONTEND_URL}${verifyPath}` : verifyPath;
  const from = process.env.EMAIL_FROM?.trim() || process.env.SMTP_USER?.trim() || 'noreply@localhost';
  const transport = getMailTransport();
  if (!transport) {
    console.warn(`[email] SMTP not configured. Verification link for ${toEmail}:\n${link}`);
    return;
  }
  await transport.sendMail({
    from,
    to: toEmail,
    subject: 'Verify your Daily Checklist Tracker account',
    text: `Open this link to verify your email and activate your account (expires in ${VERIFY_EXPIRY_HOURS} hours):\n\n${link}\n`,
    html: `<p>Verify your email to finish signing up for <strong>Daily Checklist Tracker</strong>.</p><p><a href="${link}">Verify email</a></p><p>Or paste this URL into your browser:</p><p style="word-break:break-all">${link}</p><p>This link expires in ${VERIFY_EXPIRY_HOURS} hours.</p>`,
  });
}

async function readState(userId) {
  const { rows } = await pool.query(
    `SELECT id, weekday_index, name, sort_order, effective_from, effective_to, one_day_date, suppress_weekly_activity_id
     FROM activities
     WHERE user_id = $1
     ORDER BY one_day_date ASC NULLS FIRST, weekday_index ASC, effective_from ASC, sort_order ASC`,
    [userId]
  );
  const activities = rows.map((r) => ({
    id: r.id,
    name: r.name,
    weekdayIndex: r.weekday_index,
    oneDayDate: r.one_day_date,
    suppressWeeklyActivityId: r.suppress_weekly_activity_id ?? null,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
    sortOrder: r.sort_order,
  }));
  const { rows: comps } = await pool.query(
    `SELECT date_key, activity_id FROM completions WHERE user_id = $1`,
    [userId]
  );
  const doneKeys = comps.map((c) => `${c.date_key}::${c.activity_id}`).sort();
  return { version: 3, activities, doneKeys };
}

async function writeState(userId, body) {
  const normalized = normalizeRoutineBody(body);
  if (!normalized) return false;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM completions WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM activities WHERE user_id = $1', [userId]);

    for (const a of normalized.activities) {
      await client.query(
        `INSERT INTO activities (user_id, id, weekday_index, name, sort_order, effective_from, effective_to, one_day_date, suppress_weekly_activity_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          userId,
          a.id,
          a.weekdayIndex,
          a.name,
          a.sortOrder,
          a.effectiveFrom,
          a.effectiveTo ?? null,
          typeof a.oneDayDate === 'string' ? a.oneDayDate : null,
          typeof a.suppressWeeklyActivityId === 'string' && a.suppressWeeklyActivityId
            ? a.suppressWeeklyActivityId
            : null,
        ]
      );
    }

    const validActivityIds = activityIdSet(normalized.activities);
    for (const k of normalized.doneKeys) {
      if (typeof k !== 'string') continue;
      const sep = k.indexOf('::');
      if (sep <= 0) continue;
      const dateKey = k.slice(0, sep);
      const activityId = k.slice(sep + 2);
      if (!dateKey || !activityId || !YMD.test(dateKey)) continue;
      if (!validActivityIds.has(activityId)) continue;
      await client.query(
        `INSERT INTO completions (user_id, date_key, activity_id) VALUES ($1, $2, $3)`,
        [userId, dateKey, activityId]
      );
    }

    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function initDb() {
  if (!DATABASE_URL) {
    console.error(
      'DATABASE_URL is required. Add a PostgreSQL connection string to server/.env (see .env.example).'
    );
    process.exit(1);
  }
  pool = buildPgPool();
  await ensureSchema();
  console.log('PostgreSQL connected');
}

/** Queue signup: store hash + token, send email. Fails if email already registered or verified user exists. */
async function queueRegistration(email, password) {
  const existing = await pool.query(`SELECT 1 FROM users WHERE email = $1`, [email]);
  if (existing.rows.length > 0) return { error: 'email_taken' };

  const hash = bcrypt.hashSync(password, 10);
  const token = randomBytes(VERIFY_TOKEN_BYTES).toString('hex');
  const expiresAt = new Date(Date.now() + VERIFY_EXPIRY_HOURS * 60 * 60 * 1000);

  await pool.query(
    `INSERT INTO pending_registrations (email, password_hash, token, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       token = EXCLUDED.token,
       expires_at = EXCLUDED.expires_at,
       created_at = NOW()`,
    [email, hash, token, expiresAt.toISOString()]
  );

  await sendVerificationEmail(email, token);
  return { ok: true };
}

/** Create user from pending row; returns user or error code. */
async function verifyRegistrationToken(token) {
  if (typeof token !== 'string' || token.length < 16) return { error: 'invalid_token' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `DELETE FROM pending_registrations WHERE token = $1 AND expires_at > NOW() RETURNING email, password_hash`,
      [token]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return { error: 'invalid_or_expired_token' };
    }
    const { email, password_hash } = rows[0];
    const id = randomUUID();
    try {
      await client.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`, [
        id,
        email,
        password_hash,
      ]);
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === '23505') return { error: 'email_taken' };
      throw e;
    }
    await client.query('COMMIT');
    return { user: { id, email } };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function loginUser(email, password) {
  const { rows } = await pool.query(`SELECT id, email, password_hash FROM users WHERE email = $1`, [
    email,
  ]);
  if (rows.length > 0) {
    const u = rows[0];
    if (!bcrypt.compareSync(password, u.password_hash)) return { error: 'invalid_credentials' };
    return { user: { id: u.id, email: u.email } };
  }
  const pend = await pool.query(
    `SELECT 1 FROM pending_registrations WHERE email = $1 AND expires_at > NOW()`,
    [email]
  );
  if (pend.rows.length > 0) return { error: 'pending_verification' };
  return { error: 'invalid_credentials' };
}

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '2mb' }));

app.post('/api/auth/register', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    if (!isValidEmail(email) || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'invalid_input' });
    }
    if (process.env.NODE_ENV === 'production') {
      if (!getMailTransport()) {
        return res.status(503).json({ error: 'email_not_configured' });
      }
      if (!FRONTEND_URL) {
        return res.status(503).json({ error: 'frontend_url_not_configured' });
      }
    }
    const result = await queueRegistration(email, password);
    if (result.error === 'email_taken') return res.status(409).json({ error: 'email_taken' });
    res.status(201).json({ verificationSent: true, email });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'register_failed' });
  }
});

app.post('/api/auth/verify-email', async (req, res) => {
  try {
    const token = req.body?.token;
    const result = await verifyRegistrationToken(token);
    if (result.error === 'invalid_token' || result.error === 'invalid_or_expired_token') {
      return res.status(400).json({ error: result.error });
    }
    if (result.error === 'email_taken') {
      return res.status(409).json({ error: 'email_taken' });
    }
    const jwt = signToken(result.user.id);
    res.status(201).json({ token: jwt, user: { id: result.user.id, email: result.user.email } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'verify_failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    if (!isValidEmail(email) || typeof password !== 'string') {
      return res.status(400).json({ error: 'invalid_input' });
    }
    const result = await loginUser(email, password);
    if (result.error === 'pending_verification') {
      return res.status(403).json({ error: 'pending_verification' });
    }
    if (result.error === 'invalid_credentials') {
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    const token = signToken(result.user.id);
    res.json({ token, user: { id: result.user.id, email: result.user.email } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'login_failed' });
  }
});

app.get('/api/routine', requireAuth, async (req, res) => {
  try {
    res.json(await readState(req.userId));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'read_failed' });
  }
});

app.put('/api/routine', requireAuth, async (req, res) => {
  try {
    const ok = await writeState(req.userId, req.body);
    if (!ok) {
      return res.status(400).json({ error: 'invalid_body' });
    }
    res.json(await readState(req.userId));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'write_failed' });
  }
});

/** Optional: serve Angular production build from the same origin as `/api` (set STATIC_DIR on the server). */
function attachSpaStatic() {
  const raw = process.env.STATIC_DIR?.trim();
  if (!raw) return;
  const root = raw.startsWith('/') ? resolve(raw) : resolve(__dirname, '..', raw);
  if (!existsSync(root) || !existsSync(join(root, 'index.html'))) {
    console.warn(`STATIC_DIR missing or no index.html: ${root} (API only)`);
    return;
  }
  app.use(express.static(root));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(join(root, 'index.html'), (err) => (err ? next(err) : undefined));
  });
  console.log(`Serving SPA from ${root}`);
}

attachSpaStatic();

async function main() {
  await initDb();
  const server = app.listen(PORT, HOST, () => {
    console.log(`Listening on http://${HOST}:${PORT}`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `Port ${PORT} is already in use. Stop the other process (e.g. another terminal running the API) or set PORT in server/.env and update proxy.conf.json to match.`
      );
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
