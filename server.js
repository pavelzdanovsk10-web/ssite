require('dotenv').config();

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { DatabaseSync } = require('node:sqlite');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const DATA_DIR = path.resolve(process.env.DATA_DIR || __dirname);
const DB_PATH = path.join(DATA_DIR, 'foundation.db');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const GAME_API_KEY = String(process.env.GAME_API_KEY || '');
const ALLOW_REGISTRATION = String(process.env.ALLOW_REGISTRATION || 'true').toLowerCase() === 'true';
const REGISTRATION_CODE = String(process.env.REGISTRATION_CODE || '');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
  maxHttpBufferSize: 2 * 1024 * 1024
});
const db = new DatabaseSync(DB_PATH);

app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://cdn.discordapp.com', 'https://avatars.steamstatic.com', 'https://avatars.cloudflare.steamstatic.com'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      formAction: ["'self'", 'https://steamcommunity.com'],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '1d' }));
app.use(express.static(path.join(__dirname, 'public')));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много попыток. Повторите позже.' }
});

const gameLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов от игрового сервера.' }
});

async function run(sql, params = []) {
  const statement = db.prepare(sql);
  const result = statement.run(...params);
  return {
    id: result.lastInsertRowid === undefined ? 0 : Number(result.lastInsertRowid),
    changes: Number(result.changes || 0)
  };
}

async function get(sql, params = []) {
  return db.prepare(sql).get(...params);
}

async function all(sql, params = []) {
  return db.prepare(sql).all(...params);
}

async function tableColumns(table) {
  return all(`PRAGMA table_info(${table})`);
}

async function ensureColumn(table, name, definition) {
  const columns = await tableColumns(table);
  if (!columns.some(column => column.name === name)) {
    await run(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, accessLevel: user.access_level },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function normalizeSteamId(value) {
  return String(value || '').trim().replace(/@steam$/i, '');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function calculateEventPoints(durationSeconds) {
  const seconds = Math.max(0, Number(durationSeconds) || 0);
  if (seconds < 10 * 60) return 0;
  if (seconds < 30 * 60) return 2;
  if (seconds <= 60 * 60) return 3;
  return 5;
}

function serializeUser(row, viewer = null) {
  const ownProfile = viewer && Number(viewer.id) === Number(row.id);
  const manager = viewer && ['owner', 'admin', 'supervisor'].includes(viewer.role);
  return {
    id: row.id,
    login: ownProfile || manager ? row.login : undefined,
    nickname: row.nickname,
    avatar: row.avatar || '',
    role: row.role,
    accessLevel: row.access_level,
    strictReprimands: row.strict_reprimands,
    verbalWarnings: row.verbal_warnings,
    position: row.position || '',
    status: row.status || 'Активен',
    approved: Boolean(row.approved),
    discordLinked: Boolean(row.discord_id),
    discordId: ownProfile || manager ? (row.discord_id || '') : undefined,
    discordUsername: row.discord_username || '',
    discordAvatar: row.discord_avatar || '',
    steamLinked: Boolean(row.steam_id),
    steamId: ownProfile || manager ? (row.steam_id || '') : undefined,
    steamUsername: row.steam_username || '',
    steamAvatar: row.steam_avatar || '',
    eventPoints: Number(row.event_points || 0),
    eventCount: Number(row.event_count || 0),
    totalEventSeconds: Number(row.total_event_seconds || 0),
    lastEventAt: row.last_event_at || null,
    createdAt: row.created_at
  };
}

async function userById(id) {
  return get(`
    SELECT u.*,
      (SELECT COUNT(*) FROM events e WHERE e.host_user_id=u.id AND e.status='completed') AS event_count,
      (SELECT COALESCE(SUM(e.duration_seconds),0) FROM events e WHERE e.host_user_id=u.id AND e.status='completed') AS total_event_seconds
    FROM users u WHERE u.id=?
  `, [id]);
}

async function userBySteamId(steamId) {
  return get(`
    SELECT u.*,
      (SELECT COUNT(*) FROM events e WHERE e.host_user_id=u.id AND e.status='completed') AS event_count,
      (SELECT COALESCE(SUM(e.duration_seconds),0) FROM events e WHERE e.host_user_id=u.id AND e.status='completed') AS total_event_seconds
    FROM users u WHERE u.steam_id=?
  `, [normalizeSteamId(steamId)]);
}

async function userByDiscordId(discordId) {
  return get(`
    SELECT u.*,
      (SELECT COUNT(*) FROM events e WHERE e.host_user_id=u.id AND e.status='completed') AS event_count,
      (SELECT COALESCE(SUM(e.duration_seconds),0) FROM events e WHERE e.host_user_id=u.id AND e.status='completed') AS total_event_seconds
    FROM users u WHERE u.discord_id=?
  `, [String(discordId)]);
}

async function auth(req, res, next) {
  try {
    const token = req.cookies.session;
    if (!token) return res.status(401).json({ error: 'Требуется авторизация.' });
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await userById(payload.id);
    if (!user) return res.status(401).json({ error: 'Пользователь не найден.' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Сессия недействительна.' });
  }
}

function requireRoles(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Недостаточно прав.' });
    next();
  };
}

function requireApproved(req, res, next) {
  if (!req.user.approved) return res.status(403).json({ error: 'Аккаунт ещё не подтверждён руководителем.' });
  next();
}

function gameAuth(req, res, next) {
  const provided = req.get('x-api-key') || req.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!GAME_API_KEY) return res.status(503).json({ error: 'GAME_API_KEY не настроен на сайте.' });
  if (!safeEqual(provided, GAME_API_KEY)) return res.status(401).json({ error: 'Неверный ключ игрового сервера.' });
  next();
}

function clampWarning(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 3) return null;
  return n;
}

function baseUrl(req) {
  return String(process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

async function audit(actorId, action, targetUserId = null, details = {}) {
  await run(
    'INSERT INTO audit_log (actor_id, action, target_user_id, details) VALUES (?, ?, ?, ?)',
    [actorId || null, action, targetUserId || null, JSON.stringify(details)]
  );
}

async function initDb() {
  await run('PRAGMA foreign_keys = ON');
  await run('PRAGMA journal_mode = WAL');

  await run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    nickname TEXT NOT NULL,
    avatar TEXT DEFAULT '',
    role TEXT NOT NULL DEFAULT 'employee' CHECK(role IN ('owner','admin','supervisor','employee')),
    access_level INTEGER NOT NULL DEFAULT 1 CHECK(access_level BETWEEN 0 AND 5),
    strict_reprimands INTEGER NOT NULL DEFAULT 0 CHECK(strict_reprimands BETWEEN 0 AND 3),
    verbal_warnings INTEGER NOT NULL DEFAULT 0 CHECK(verbal_warnings BETWEEN 0 AND 3),
    position TEXT DEFAULT '',
    status TEXT DEFAULT 'Активен',
    approved INTEGER NOT NULL DEFAULT 1,
    discord_id TEXT DEFAULT '',
    discord_username TEXT DEFAULT '',
    discord_avatar TEXT DEFAULT '',
    steam_id TEXT DEFAULT '',
    steam_username TEXT DEFAULT '',
    steam_avatar TEXT DEFAULT '',
    event_points INTEGER NOT NULL DEFAULT 0,
    last_event_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  await ensureColumn('users', 'approved', 'INTEGER NOT NULL DEFAULT 1');
  await ensureColumn('users', 'discord_id', "TEXT DEFAULT ''");
  await ensureColumn('users', 'discord_username', "TEXT DEFAULT ''");
  await ensureColumn('users', 'discord_avatar', "TEXT DEFAULT ''");
  await ensureColumn('users', 'steam_id', "TEXT DEFAULT ''");
  await ensureColumn('users', 'steam_username', "TEXT DEFAULT ''");
  await ensureColumn('users', 'steam_avatar', "TEXT DEFAULT ''");
  await ensureColumn('users', 'event_points', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('users', 'last_event_at', 'TEXT');
  await ensureColumn('users', 'updated_at', 'TEXT');

  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_discord_unique
    ON users(discord_id) WHERE discord_id IS NOT NULL AND discord_id <> ''`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_steam_unique
    ON users(steam_id) WHERE steam_id IS NOT NULL AND steam_id <> ''`);

  await run(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_uid TEXT UNIQUE NOT NULL,
    server_id TEXT NOT NULL,
    name TEXT NOT NULL,
    host_user_id INTEGER,
    host_steam_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    points_awarded INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','cancelled','forced')),
    cancellation_reason TEXT DEFAULT '',
    discord_message_id TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(host_user_id) REFERENCES users(id) ON DELETE SET NULL
  )`);
  await run('CREATE INDEX IF NOT EXISTS idx_events_host ON events(host_user_id, id DESC)');
  await run('CREATE INDEX IF NOT EXISTS idx_events_server_status ON events(server_id, status)');

  await run(`CREATE TABLE IF NOT EXISTS point_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    event_id INTEGER,
    amount INTEGER NOT NULL,
    reason TEXT NOT NULL,
    actor_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE SET NULL,
    FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE SET NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS disciplinary_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('verbal','strict')),
    reason TEXT NOT NULL,
    comment TEXT DEFAULT '',
    issued_by INTEGER,
    issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    removed_at TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','removed')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(issued_by) REFERENCES users(id) ON DELETE SET NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('direct','group')),
    title TEXT DEFAULT '',
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(conversation_id, user_id),
    FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY(sender_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id INTEGER,
    action TEXT NOT NULL,
    target_user_id INTEGER,
    details TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY(target_user_id) REFERENCES users(id) ON DELETE SET NULL
  )`);

  const existing = await get('SELECT id FROM users LIMIT 1');
  if (!existing) {
    const login = process.env.ADMIN_LOGIN || 'administrator';
    const password = process.env.ADMIN_PASSWORD || 'ChangeMe_123!';
    const hash = await bcrypt.hash(password, 12);
    await run(`INSERT INTO users
      (login, password_hash, nickname, role, access_level, position, approved, status)
      VALUES (?, ?, ?, 'owner', 5, 'Руководитель администрации', 1, 'Активен')`,
      [login, hash, 'Администратор']);
    console.log(`Создан владелец: ${login}`);
  }
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowed.includes(file.mimetype)) return cb(new Error('Допустимы JPG, PNG, WEBP или GIF.'));
    cb(null, true);
  }
});

app.get('/api/config', (_req, res) => {
  res.json({
    allowRegistration: ALLOW_REGISTRATION,
    registrationCodeRequired: Boolean(REGISTRATION_CODE),
    discordOAuthEnabled: Boolean(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET),
    steamOAuthEnabled: true,
    discordBotEnabled: Boolean(process.env.DISCORD_BOT_TOKEN),
    pointsRules: [
      { minSeconds: 0, maxSeconds: 599, points: 0 },
      { minSeconds: 600, maxSeconds: 1799, points: 2 },
      { minSeconds: 1800, maxSeconds: 3600, points: 3 },
      { minSeconds: 3601, maxSeconds: null, points: 5 }
    ]
  });
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const login = String(req.body.login || '').trim();
    const password = String(req.body.password || '');
    if (!login || !password) return res.status(400).json({ error: 'Введите логин и пароль.' });

    const user = await get('SELECT * FROM users WHERE login=?', [login]);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Неверный логин или пароль.' });
    }

    res.cookie('session', signToken(user), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    res.json({ user: serializeUser(await userById(user.id), user) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка сервера.' });
  }
});

app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    if (!ALLOW_REGISTRATION) return res.status(403).json({ error: 'Самостоятельная регистрация отключена.' });
    if (REGISTRATION_CODE && !safeEqual(req.body.registrationCode, REGISTRATION_CODE)) {
      return res.status(403).json({ error: 'Неверный код регистрации.' });
    }

    const login = String(req.body.login || '').trim();
    const password = String(req.body.password || '');
    const nickname = String(req.body.nickname || '').trim();
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(login)) {
      return res.status(400).json({ error: 'Логин: 3–32 символа, латиница, цифры, точка, дефис или подчёркивание.' });
    }
    if (password.length < 8) return res.status(400).json({ error: 'Пароль должен содержать минимум 8 символов.' });
    if (!nickname || nickname.length > 40) return res.status(400).json({ error: 'Укажите ник до 40 символов.' });

    const hash = await bcrypt.hash(password, 12);
    const result = await run(`INSERT INTO users
      (login, password_hash, nickname, role, access_level, position, approved, status)
      VALUES (?, ?, ?, 'employee', 0, 'Кандидат', 0, 'Ожидает подтверждения')`,
      [login, hash, nickname]);
    const user = await userById(result.id);
    res.cookie('session', signToken(user), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    await audit(result.id, 'user_registered', result.id, {});
    res.status(201).json({ user: serializeUser(user, user) });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return res.status(409).json({ error: 'Такой логин уже занят.' });
    console.error(error);
    res.status(500).json({ error: 'Не удалось создать аккаунт.' });
  }
});

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie('session');
  res.json({ ok: true });
});

app.get('/api/me', auth, async (req, res) => {
  res.json({ user: serializeUser(await userById(req.user.id), req.user) });
});

app.get('/api/me/dashboard', auth, async (req, res) => {
  const user = await userById(req.user.id);
  const events = await all(`
    SELECT event_uid, server_id, name, started_at, finished_at, duration_seconds, points_awarded, status
    FROM events WHERE host_user_id=? ORDER BY id DESC LIMIT 50
  `, [req.user.id]);
  const discipline = await all(`
    SELECT d.id, d.type, d.reason, d.comment, d.issued_at, d.removed_at, d.status,
           issuer.nickname AS issuer_name
    FROM disciplinary_actions d
    LEFT JOIN users issuer ON issuer.id=d.issued_by
    WHERE d.user_id=? ORDER BY d.id DESC LIMIT 50
  `, [req.user.id]);
  res.json({ user: serializeUser(user, req.user), events, discipline });
});

app.get('/api/users', auth, async (req, res) => {
  if (!req.user.approved) {
    const self = await userById(req.user.id);
    return res.json({ users: [serializeUser(self, req.user)] });
  }
  const rows = await all(`
    SELECT u.*,
      (SELECT COUNT(*) FROM events e WHERE e.host_user_id=u.id AND e.status='completed') AS event_count,
      (SELECT COALESCE(SUM(e.duration_seconds),0) FROM events e WHERE e.host_user_id=u.id AND e.status='completed') AS total_event_seconds
    FROM users u
    ORDER BY u.approved DESC, u.access_level DESC, u.nickname COLLATE NOCASE
  `);
  res.json({ users: rows.map(row => serializeUser(row, req.user)) });
});

app.get('/api/users/:id/profile', auth, async (req, res) => {
  if (!req.user.approved && Number(req.params.id) !== Number(req.user.id)) {
    return res.status(403).json({ error: 'Аккаунт ещё не подтверждён руководителем.' });
  }
  const target = await userById(Number(req.params.id));
  if (!target) return res.status(404).json({ error: 'Сотрудник не найден.' });
  const events = await all(`
    SELECT event_uid, server_id, name, started_at, finished_at, duration_seconds, points_awarded, status
    FROM events WHERE host_user_id=? ORDER BY id DESC LIMIT 30
  `, [target.id]);
  const canSeeDiscipline = target.id === req.user.id || ['owner', 'admin', 'supervisor'].includes(req.user.role);
  const discipline = canSeeDiscipline ? await all(`
    SELECT d.id, d.type, d.reason, d.comment, d.issued_at, d.removed_at, d.status,
           issuer.nickname AS issuer_name
    FROM disciplinary_actions d
    LEFT JOIN users issuer ON issuer.id=d.issued_by
    WHERE d.user_id=? ORDER BY d.id DESC LIMIT 50
  `, [target.id]) : [];
  res.json({ user: serializeUser(target, req.user), events, discipline });
});

app.post('/api/users', auth, requireRoles('owner', 'admin'), async (req, res) => {
  try {
    const login = String(req.body.login || '').trim();
    const password = String(req.body.password || '');
    const nickname = String(req.body.nickname || '').trim();
    const role = ['admin', 'supervisor', 'employee'].includes(req.body.role) ? req.body.role : 'employee';
    const accessLevel = Math.max(0, Math.min(5, Number(req.body.accessLevel || 1)));
    const position = String(req.body.position || '').trim().slice(0, 80);
    const status = String(req.body.status || 'Активен').trim().slice(0, 40);
    const approved = req.body.approved === false ? 0 : 1;
    const discordId = String(req.body.discordId || '').trim();
    const discordUsername = String(req.body.discordUsername || '').trim().slice(0, 80);
    const steamId = normalizeSteamId(req.body.steamId);
    const steamUsername = String(req.body.steamUsername || '').trim().slice(0, 80);

    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(login)) {
      return res.status(400).json({ error: 'Логин: 3–32 символа, латиница, цифры, точка, дефис или подчёркивание.' });
    }
    if (password.length < 8) return res.status(400).json({ error: 'Пароль должен содержать минимум 8 символов.' });
    if (!nickname || nickname.length > 40) return res.status(400).json({ error: 'Укажите ник до 40 символов.' });
    if (req.user.role !== 'owner' && role === 'admin') return res.status(403).json({ error: 'Только владелец может назначать администраторов.' });
    if (req.user.role !== 'owner' && accessLevel >= req.user.access_level) return res.status(403).json({ error: 'Нельзя выдать уровень не ниже собственного.' });

    const hash = await bcrypt.hash(password, 12);
    const result = await run(`INSERT INTO users
      (login, password_hash, nickname, role, access_level, position, status, approved,
       discord_id, discord_username, steam_id, steam_username)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [login, hash, nickname, role, accessLevel, position, status, approved,
        discordId, discordUsername, steamId, steamUsername]);
    await audit(req.user.id, 'user_created', result.id, { role, accessLevel, approved });
    const created = await userById(result.id);
    res.status(201).json({ user: serializeUser(created, req.user) });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return res.status(409).json({ error: 'Логин, Discord или Steam уже привязан к другому аккаунту.' });
    console.error(error);
    res.status(500).json({ error: 'Не удалось создать сотрудника.' });
  }
});

app.patch('/api/users/:id', auth, requireRoles('owner', 'admin', 'supervisor'), async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const target = await userById(targetId);
    if (!target) return res.status(404).json({ error: 'Сотрудник не найден.' });
    if (target.role === 'owner' && req.user.role !== 'owner') return res.status(403).json({ error: 'Нельзя изменять владельца.' });
    if (req.user.role === 'supervisor' && target.access_level >= req.user.access_level) {
      return res.status(403).json({ error: 'Можно изменять только сотрудников с более низким уровнем.' });
    }

    const nickname = String(req.body.nickname ?? target.nickname).trim().slice(0, 40);
    const position = String(req.body.position ?? target.position).trim().slice(0, 80);
    const status = String(req.body.status ?? target.status).trim().slice(0, 40);
    let role = req.body.role ?? target.role;
    if (!['owner', 'admin', 'supervisor', 'employee'].includes(role)) role = target.role;
    let accessLevel = Number(req.body.accessLevel ?? target.access_level);
    accessLevel = Math.max(0, Math.min(5, accessLevel));
    const strict = clampWarning(req.body.strictReprimands ?? target.strict_reprimands);
    const verbal = clampWarning(req.body.verbalWarnings ?? target.verbal_warnings);
    const approved = req.body.approved === undefined ? Number(target.approved) : (req.body.approved ? 1 : 0);
    const discordId = String(req.body.discordId ?? target.discord_id ?? '').trim();
    const discordUsername = String(req.body.discordUsername ?? target.discord_username ?? '').trim().slice(0, 80);
    const steamId = normalizeSteamId(req.body.steamId ?? target.steam_id ?? '');
    const steamUsername = String(req.body.steamUsername ?? target.steam_username ?? '').trim().slice(0, 80);

    if (strict === null || verbal === null) return res.status(400).json({ error: 'Количество предупреждений должно быть от 0 до 3.' });
    if (req.user.role !== 'owner' && ['owner', 'admin'].includes(role)) return res.status(403).json({ error: 'Недостаточно прав для назначения этой роли.' });
    if (req.user.role !== 'owner' && accessLevel >= req.user.access_level) return res.status(403).json({ error: 'Нельзя выдать уровень не ниже собственного.' });

    await run(`UPDATE users SET nickname=?, position=?, status=?, role=?, access_level=?,
      strict_reprimands=?, verbal_warnings=?, approved=?, discord_id=?, discord_username=?,
      steam_id=?, steam_username=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [nickname, position, status, role, accessLevel, strict, verbal, approved,
        discordId, discordUsername, steamId, steamUsername, targetId]);

    if (req.body.password) {
      const password = String(req.body.password);
      if (password.length < 8) return res.status(400).json({ error: 'Новый пароль должен содержать минимум 8 символов.' });
      await run('UPDATE users SET password_hash=? WHERE id=?', [await bcrypt.hash(password, 12), targetId]);
    }

    await audit(req.user.id, 'user_updated', targetId, { role, accessLevel, strict, verbal, approved });
    res.json({ user: serializeUser(await userById(targetId), req.user) });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return res.status(409).json({ error: 'Discord или Steam уже привязан к другому аккаунту.' });
    console.error(error);
    res.status(500).json({ error: 'Не удалось обновить сотрудника.' });
  }
});

app.delete('/api/users/:id', auth, requireRoles('owner', 'admin'), async (req, res) => {
  const targetId = Number(req.params.id);
  if (targetId === req.user.id) return res.status(400).json({ error: 'Нельзя удалить собственную учётную запись.' });
  const target = await userById(targetId);
  if (!target) return res.status(404).json({ error: 'Сотрудник не найден.' });
  if (target.role === 'owner') return res.status(403).json({ error: 'Нельзя удалить владельца.' });
  if (req.user.role !== 'owner' && target.role === 'admin') return res.status(403).json({ error: 'Только владелец может удалить администратора.' });
  await audit(req.user.id, 'user_deleted', targetId, { nickname: target.nickname });
  await run('DELETE FROM users WHERE id=?', [targetId]);
  res.json({ ok: true });
});

app.post('/api/users/:id/avatar', auth, upload.single('avatar'), async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    if (targetId !== req.user.id && !['owner', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Недостаточно прав.' });
    }
    const target = await userById(targetId);
    if (!target) return res.status(404).json({ error: 'Сотрудник не найден.' });
    if (!req.file) return res.status(400).json({ error: 'Файл не выбран.' });

    const avatar = `/uploads/${req.file.filename}`;
    await run('UPDATE users SET avatar=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [avatar, targetId]);
    await audit(req.user.id, 'avatar_updated', targetId, {});
    res.json({ user: serializeUser(await userById(targetId), req.user) });
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message || 'Не удалось загрузить аватар.' });
  }
});

app.post('/api/users/:id/discipline', auth, requireRoles('owner', 'admin', 'supervisor'), async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const target = await userById(targetId);
    if (!target) return res.status(404).json({ error: 'Сотрудник не найден.' });
    if (target.role === 'owner' && req.user.role !== 'owner') return res.status(403).json({ error: 'Нельзя выдать взыскание владельцу.' });
    if (req.user.role === 'supervisor' && target.access_level >= req.user.access_level) {
      return res.status(403).json({ error: 'Можно изменять только сотрудников с более низким уровнем.' });
    }
    const type = req.body.type === 'strict' ? 'strict' : 'verbal';
    const reason = String(req.body.reason || '').trim().slice(0, 300);
    const comment = String(req.body.comment || '').trim().slice(0, 1000);
    if (!reason) return res.status(400).json({ error: 'Укажите причину.' });
    const current = type === 'strict' ? target.strict_reprimands : target.verbal_warnings;
    if (current >= 3) return res.status(400).json({ error: 'У сотрудника уже максимальное количество взысканий этого типа.' });

    const result = await run(`INSERT INTO disciplinary_actions
      (user_id, type, reason, comment, issued_by) VALUES (?, ?, ?, ?, ?)`,
      [targetId, type, reason, comment, req.user.id]);
    if (type === 'strict') await run('UPDATE users SET strict_reprimands=strict_reprimands+1 WHERE id=?', [targetId]);
    else await run('UPDATE users SET verbal_warnings=verbal_warnings+1 WHERE id=?', [targetId]);
    await audit(req.user.id, 'discipline_issued', targetId, { type, reason, actionId: result.id });
    res.status(201).json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось выдать взыскание.' });
  }
});

app.delete('/api/discipline/:id', auth, requireRoles('owner', 'admin', 'supervisor'), async (req, res) => {
  try {
    const action = await get('SELECT * FROM disciplinary_actions WHERE id=?', [Number(req.params.id)]);
    if (!action || action.status !== 'active') return res.status(404).json({ error: 'Активное взыскание не найдено.' });
    const target = await userById(action.user_id);
    if (req.user.role === 'supervisor' && target.access_level >= req.user.access_level) {
      return res.status(403).json({ error: 'Недостаточно прав.' });
    }
    await run("UPDATE disciplinary_actions SET status='removed', removed_at=CURRENT_TIMESTAMP WHERE id=?", [action.id]);
    if (action.type === 'strict') {
      await run('UPDATE users SET strict_reprimands=MAX(strict_reprimands-1,0) WHERE id=?', [action.user_id]);
    } else {
      await run('UPDATE users SET verbal_warnings=MAX(verbal_warnings-1,0) WHERE id=?', [action.user_id]);
    }
    await audit(req.user.id, 'discipline_removed', action.user_id, { actionId: action.id, type: action.type });
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось снять взыскание.' });
  }
});

app.get('/api/events', auth, requireApproved, async (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit || 100)));
  const events = await all(`
    SELECT e.event_uid, e.server_id, e.name, e.host_steam_id, e.started_at, e.finished_at,
           e.duration_seconds, e.points_awarded, e.status, e.cancellation_reason,
           u.id AS host_user_id, u.nickname AS host_name, u.position AS host_position,
           u.discord_id AS host_discord_id
    FROM events e LEFT JOIN users u ON u.id=e.host_user_id
    ORDER BY e.id DESC LIMIT ?
  `, [limit]);
  res.json({ events });
});

app.get('/api/ranking', auth, requireApproved, async (_req, res) => {
  const users = await all(`
    SELECT u.id, u.nickname, u.avatar, u.position, u.access_level, u.event_points,
      COUNT(CASE WHEN e.status='completed' THEN 1 END) AS event_count,
      COALESCE(SUM(CASE WHEN e.status='completed' THEN e.duration_seconds ELSE 0 END),0) AS total_event_seconds
    FROM users u LEFT JOIN events e ON e.host_user_id=u.id
    WHERE u.approved=1
    GROUP BY u.id
    ORDER BY u.event_points DESC, event_count DESC, u.nickname COLLATE NOCASE
    LIMIT 100
  `);
  res.json({ users });
});

app.post('/api/events/:uid/points', auth, requireRoles('owner', 'admin'), async (req, res) => {
  try {
    const event = await get('SELECT * FROM events WHERE event_uid=?', [req.params.uid]);
    if (!event) return res.status(404).json({ error: 'Ивент не найден.' });
    if (!event.host_user_id) return res.status(400).json({ error: 'Организатор не привязан к аккаунту.' });
    const newPoints = Math.max(0, Math.min(100, Number(req.body.points)));
    if (!Number.isInteger(newPoints)) return res.status(400).json({ error: 'Баллы должны быть целым числом.' });
    const delta = newPoints - Number(event.points_awarded || 0);
    await run('BEGIN IMMEDIATE');
    try {
      await run('UPDATE events SET points_awarded=? WHERE id=?', [newPoints, event.id]);
      await run('UPDATE users SET event_points=MAX(event_points+?,0) WHERE id=?', [delta, event.host_user_id]);
      await run(`INSERT INTO point_transactions (user_id, event_id, amount, reason, actor_id)
        VALUES (?, ?, ?, ?, ?)`, [event.host_user_id, event.id, delta, 'Ручная корректировка баллов', req.user.id]);
      await run('COMMIT');
    } catch (error) {
      await run('ROLLBACK');
      throw error;
    }
    await audit(req.user.id, 'event_points_adjusted', event.host_user_id, { eventUid: event.event_uid, from: event.points_awarded, to: newPoints });
    res.json({ ok: true, points: newPoints });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось изменить баллы.' });
  }
});

app.get('/api/integrations/status', auth, async (req, res) => {
  const user = await userById(req.user.id);
  const inviteUrl = process.env.DISCORD_CLIENT_ID
    ? `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(process.env.DISCORD_CLIENT_ID)}&permissions=84992&scope=bot%20applications.commands`
    : '';
  res.json({
    discord: { linked: Boolean(user.discord_id), username: user.discord_username || '', enabled: Boolean(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET) },
    steam: { linked: Boolean(user.steam_id), username: user.steam_username || '', enabled: true },
    bot: { configured: Boolean(process.env.DISCORD_BOT_TOKEN), inviteUrl: req.user.role === 'owner' ? inviteUrl : '' }
  });
});

app.get('/api/integrations/discord/start', auth, (req, res) => {
  if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) {
    return res.status(503).send('Discord OAuth не настроен.');
  }
  const redirectUri = `${baseUrl(req)}/api/integrations/discord/callback`;
  const state = jwt.sign({ purpose: 'discord-link', userId: req.user.id }, JWT_SECRET, { expiresIn: '10m' });
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: 'identify',
    state
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

app.get('/api/integrations/discord/callback', async (req, res) => {
  try {
    const payload = jwt.verify(String(req.query.state || ''), JWT_SECRET);
    if (payload.purpose !== 'discord-link') throw new Error('invalid state');
    const redirectUri = `${baseUrl(req)}/api/integrations/discord/callback`;
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: String(req.query.code || ''),
        redirect_uri: redirectUri
      })
    });
    if (!tokenResponse.ok) throw new Error(`discord token ${tokenResponse.status}`);
    const token = await tokenResponse.json();
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });
    if (!userResponse.ok) throw new Error(`discord user ${userResponse.status}`);
    const discordUser = await userResponse.json();
    const avatar = discordUser.avatar
      ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png?size=256`
      : '';
    await run(`UPDATE users SET discord_id=?, discord_username=?, discord_avatar=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [discordUser.id, discordUser.global_name || discordUser.username, avatar, payload.userId]);
    await audit(payload.userId, 'discord_linked', payload.userId, { discordId: discordUser.id });
    res.redirect('/?integration=discord-ok#profile');
  } catch (error) {
    console.error('Discord OAuth:', error);
    res.redirect('/?integration=discord-error#profile');
  }
});

app.get('/api/integrations/steam/start', auth, (req, res) => {
  const callback = `${baseUrl(req)}/api/integrations/steam/callback`;
  const state = jwt.sign({ purpose: 'steam-link', userId: req.user.id }, JWT_SECRET, { expiresIn: '10m' });
  const returnTo = `${callback}?state=${encodeURIComponent(state)}`;
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': baseUrl(req),
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select'
  });
  res.redirect(`https://steamcommunity.com/openid/login?${params.toString()}`);
});

app.get('/api/integrations/steam/callback', async (req, res) => {
  try {
    const payload = jwt.verify(String(req.query.state || ''), JWT_SECRET);
    if (payload.purpose !== 'steam-link') throw new Error('invalid state');
    const verifyParams = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query)) {
      if (key.startsWith('openid.') && typeof value === 'string') verifyParams.set(key, value);
    }
    verifyParams.set('openid.mode', 'check_authentication');
    const verifyResponse = await fetch('https://steamcommunity.com/openid/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: verifyParams
    });
    const verifyText = await verifyResponse.text();
    if (!verifyText.includes('is_valid:true')) throw new Error('Steam OpenID validation failed');
    const claimedId = String(req.query['openid.claimed_id'] || '');
    const steamId = claimedId.match(/\/id\/(\d+)$/)?.[1];
    if (!steamId) throw new Error('Steam ID missing');

    let steamUsername = steamId;
    let steamAvatar = '';
    if (process.env.STEAM_WEB_API_KEY) {
      const profileResponse = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(process.env.STEAM_WEB_API_KEY)}&steamids=${steamId}`);
      if (profileResponse.ok) {
        const profile = (await profileResponse.json())?.response?.players?.[0];
        if (profile) {
          steamUsername = profile.personaname || steamId;
          steamAvatar = profile.avatarfull || profile.avatar || '';
        }
      }
    }

    await run(`UPDATE users SET steam_id=?, steam_username=?, steam_avatar=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [steamId, steamUsername, steamAvatar, payload.userId]);
    await audit(payload.userId, 'steam_linked', payload.userId, { steamId });
    res.redirect('/?integration=steam-ok#profile');
  } catch (error) {
    console.error('Steam OpenID:', error);
    res.redirect('/?integration=steam-error#profile');
  }
});

app.post('/api/integrations/:provider/unlink', auth, async (req, res) => {
  const provider = req.params.provider;
  if (provider === 'discord') {
    await run("UPDATE users SET discord_id='', discord_username='', discord_avatar='', updated_at=CURRENT_TIMESTAMP WHERE id=?", [req.user.id]);
    await audit(req.user.id, 'discord_unlinked', req.user.id, {});
  } else if (provider === 'steam') {
    await run("UPDATE users SET steam_id='', steam_username='', steam_avatar='', updated_at=CURRENT_TIMESTAMP WHERE id=?", [req.user.id]);
    await audit(req.user.id, 'steam_unlinked', req.user.id, {});
  } else {
    return res.status(400).json({ error: 'Неизвестная интеграция.' });
  }
  res.json({ ok: true });
});

app.post('/api/game/events/start', gameLimiter, gameAuth, async (req, res) => {
  try {
    const serverId = String(req.body.serverId || '').trim().slice(0, 80);
    const eventName = String(req.body.eventName || '').trim().slice(0, 120);
    const hostSteamId = normalizeSteamId(req.body.hostSteamId);
    const requestedUid = String(req.body.eventId || '').trim().slice(0, 120);
    const eventUid = requestedUid || crypto.randomUUID();
    const startedAt = req.body.startedAt && !Number.isNaN(Date.parse(req.body.startedAt))
      ? new Date(req.body.startedAt).toISOString()
      : new Date().toISOString();
    if (!serverId || !eventName || !hostSteamId) {
      return res.status(400).json({ error: 'Нужны serverId, eventName и hostSteamId.' });
    }

    const duplicate = await get('SELECT * FROM events WHERE event_uid=?', [eventUid]);
    if (duplicate) return res.json({ success: true, eventId: duplicate.event_uid, duplicate: true });
    const active = await get("SELECT event_uid FROM events WHERE server_id=? AND status='active' LIMIT 1", [serverId]);
    if (active) return res.status(409).json({ error: 'На этом сервере уже проводится ивент.', activeEventId: active.event_uid });

    const host = await userBySteamId(hostSteamId);
    const result = await run(`INSERT INTO events
      (event_uid, server_id, name, host_user_id, host_steam_id, started_at, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')`,
      [eventUid, serverId, eventName, host?.id || null, hostSteamId, startedAt]);
    await audit(host?.id || null, 'event_started', host?.id || null, { eventUid, serverId, eventName, hostSteamId });

    const messageId = await notifyDiscordEventStarted({
      eventUid,
      serverId,
      eventName,
      startedAt,
      hostName: host?.nickname || hostSteamId,
      hostPosition: host?.position || '',
      hostDiscordId: host?.discord_id || ''
    });
    if (messageId) await run('UPDATE events SET discord_message_id=? WHERE id=?', [messageId, result.id]);

    res.status(201).json({
      success: true,
      eventId: eventUid,
      hostLinked: Boolean(host),
      hostUserId: host?.id || null,
      hostName: host?.nickname || null
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось зарегистрировать начало ивента.' });
  }
});

app.post('/api/game/events/finish', gameLimiter, gameAuth, async (req, res) => {
  try {
    const eventUid = String(req.body.eventId || '').trim();
    const serverId = String(req.body.serverId || '').trim();
    const event = eventUid
      ? await get('SELECT * FROM events WHERE event_uid=?', [eventUid])
      : await get("SELECT * FROM events WHERE server_id=? AND status='active' ORDER BY id DESC LIMIT 1", [serverId]);
    if (!event) return res.status(404).json({ error: 'Активный ивент не найден.' });
    if (event.status !== 'active') {
      return res.json({ success: true, eventId: event.event_uid, duplicate: true, pointsAwarded: event.points_awarded });
    }

    const computed = Math.max(0, Math.floor((Date.now() - new Date(event.started_at).getTime()) / 1000));
    const supplied = Number(req.body.durationSeconds);
    const durationSeconds = Number.isFinite(supplied) && supplied >= 0 ? Math.floor(supplied) : computed;
    const points = calculateEventPoints(durationSeconds);
    const finishedAt = req.body.finishedAt && !Number.isNaN(Date.parse(req.body.finishedAt))
      ? new Date(req.body.finishedAt).toISOString()
      : new Date().toISOString();

    await run('BEGIN IMMEDIATE');
    try {
      const updated = await run(`UPDATE events SET status='completed', finished_at=?, duration_seconds=?, points_awarded=?
        WHERE id=? AND status='active'`, [finishedAt, durationSeconds, points, event.id]);
      if (!updated.changes) {
        await run('ROLLBACK');
        const current = await get('SELECT * FROM events WHERE id=?', [event.id]);
        return res.json({ success: true, eventId: current.event_uid, duplicate: true, pointsAwarded: current.points_awarded });
      }
      if (event.host_user_id) {
        await run('UPDATE users SET event_points=event_points+?, last_event_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
          [points, finishedAt, event.host_user_id]);
        await run(`INSERT INTO point_transactions (user_id, event_id, amount, reason)
          VALUES (?, ?, ?, ?)`, [event.host_user_id, event.id, points, `Ивент «${event.name}»`]);
      }
      await run('COMMIT');
    } catch (error) {
      await run('ROLLBACK');
      throw error;
    }

    const host = event.host_user_id ? await userById(event.host_user_id) : null;
    await audit(event.host_user_id || null, 'event_completed', event.host_user_id || null, {
      eventUid: event.event_uid,
      durationSeconds,
      points
    });
    await notifyDiscordEventFinished({
      eventUid: event.event_uid,
      serverId: event.server_id,
      eventName: event.name,
      durationSeconds,
      points,
      totalPoints: host ? Number(host.event_points || 0) : null,
      hostName: host?.nickname || event.host_steam_id,
      hostDiscordId: host?.discord_id || '',
      originalMessageId: event.discord_message_id || ''
    });

    res.json({
      success: true,
      eventId: event.event_uid,
      durationSeconds,
      pointsAwarded: points,
      totalPoints: host ? Number(host.event_points || 0) : null,
      hostLinked: Boolean(host)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось завершить ивент.' });
  }
});

app.post('/api/game/events/cancel', gameLimiter, gameAuth, async (req, res) => {
  try {
    const eventUid = String(req.body.eventId || '').trim();
    const reason = String(req.body.reason || 'Ивент отменён').trim().slice(0, 300);
    const event = await get('SELECT * FROM events WHERE event_uid=?', [eventUid]);
    if (!event) return res.status(404).json({ error: 'Ивент не найден.' });
    if (event.status !== 'active') return res.json({ success: true, duplicate: true });
    await run(`UPDATE events SET status='cancelled', finished_at=?, duration_seconds=?, points_awarded=0,
      cancellation_reason=? WHERE id=?`, [new Date().toISOString(), Math.max(0, Math.floor((Date.now() - new Date(event.started_at).getTime()) / 1000)), reason, event.id]);
    await audit(event.host_user_id || null, 'event_cancelled', event.host_user_id || null, { eventUid, reason });
    await notifyDiscordEventCancelled({
      eventUid: event.event_uid,
      eventName: event.name,
      serverId: event.server_id,
      reason,
      originalMessageId: event.discord_message_id || ''
    });
    res.json({ success: true, pointsAwarded: 0 });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось отменить ивент.' });
  }
});

app.get('/api/game/events/active', gameLimiter, gameAuth, async (req, res) => {
  const serverId = String(req.query.serverId || '').trim();
  const events = serverId
    ? await all("SELECT * FROM events WHERE status='active' AND server_id=? ORDER BY id DESC", [serverId])
    : await all("SELECT * FROM events WHERE status='active' ORDER BY id DESC");
  res.json({ events });
});

app.get('/api/conversations', auth, requireApproved, async (req, res) => {
  const rows = await all(`
    SELECT c.id, c.type, c.title, c.created_at,
      (SELECT body FROM messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_message,
      (SELECT created_at FROM messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_message_at
    FROM conversations c
    JOIN conversation_members cm ON cm.conversation_id=c.id
    WHERE cm.user_id=?
    ORDER BY COALESCE(last_message_at, c.created_at) DESC
  `, [req.user.id]);
  for (const convo of rows) {
    convo.members = (await all(`SELECT u.id, u.nickname, u.avatar, u.access_level
      FROM users u JOIN conversation_members cm ON cm.user_id=u.id
      WHERE cm.conversation_id=? ORDER BY u.nickname`, [convo.id])).map(row => ({
      id: row.id, nickname: row.nickname, avatar: row.avatar || '', accessLevel: row.access_level
    }));
  }
  res.json({ conversations: rows });
});

app.post('/api/conversations', auth, requireApproved, async (req, res) => {
  try {
    const type = req.body.type === 'group' ? 'group' : 'direct';
    const memberIds = [...new Set((Array.isArray(req.body.memberIds) ? req.body.memberIds : []).map(Number))]
      .filter(id => Number.isInteger(id) && id > 0 && id !== req.user.id);
    const title = String(req.body.title || '').trim().slice(0, 60);
    if (type === 'direct' && memberIds.length !== 1) return res.status(400).json({ error: 'Для личного чата выберите одного сотрудника.' });
    if (type === 'group' && memberIds.length < 1) return res.status(400).json({ error: 'Добавьте хотя бы одного участника.' });
    if (type === 'group' && !title) return res.status(400).json({ error: 'Укажите название группы.' });

    if (type === 'direct') {
      const existing = await get(`
        SELECT c.id FROM conversations c
        WHERE c.type='direct'
          AND (SELECT COUNT(*) FROM conversation_members WHERE conversation_id=c.id)=2
          AND EXISTS (SELECT 1 FROM conversation_members WHERE conversation_id=c.id AND user_id=?)
          AND EXISTS (SELECT 1 FROM conversation_members WHERE conversation_id=c.id AND user_id=?)
      `, [req.user.id, memberIds[0]]);
      if (existing) return res.json({ id: existing.id });
    }

    const result = await run('INSERT INTO conversations (type, title, created_by) VALUES (?, ?, ?)', [type, title, req.user.id]);
    await run('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)', [result.id, req.user.id]);
    for (const memberId of memberIds) {
      const user = await userById(memberId);
      if (user) await run('INSERT OR IGNORE INTO conversation_members (conversation_id, user_id) VALUES (?, ?)', [result.id, memberId]);
    }
    res.status(201).json({ id: result.id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось создать чат.' });
  }
});

app.get('/api/conversations/:id/messages', auth, requireApproved, async (req, res) => {
  const conversationId = Number(req.params.id);
  const member = await get('SELECT 1 FROM conversation_members WHERE conversation_id=? AND user_id=?', [conversationId, req.user.id]);
  if (!member) return res.status(403).json({ error: 'Нет доступа к чату.' });
  const messages = await all(`
    SELECT m.id, m.body, m.created_at, u.id AS sender_id, u.nickname, u.avatar
    FROM messages m JOIN users u ON u.id=m.sender_id
    WHERE m.conversation_id=? ORDER BY m.id ASC LIMIT 500
  `, [conversationId]);
  res.json({ messages });
});

app.get('/api/audit', auth, requireRoles('owner', 'admin'), async (_req, res) => {
  const logs = await all(`
    SELECT a.id, a.action, a.details, a.created_at,
      actor.nickname AS actor_name, target.nickname AS target_name
    FROM audit_log a
    LEFT JOIN users actor ON actor.id=a.actor_id
    LEFT JOIN users target ON target.id=a.target_user_id
    ORDER BY a.id DESC LIMIT 200
  `);
  res.json({ logs });
});

let discordClient = null;

function pluralizeRu(value, one, few, many) {
  const number = Math.abs(Number(value) || 0);
  const mod100 = number % 100;
  const mod10 = number % 10;
  if (mod100 >= 11 && mod100 <= 19) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function pointsLabel(value) {
  return `${value} ${pluralizeRu(value, 'балл', 'балла', 'баллов')}`;
}

function durationLabel(seconds) {
  const totalMinutes = Math.max(0, Math.floor((Number(seconds) || 0) / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!hours) return `${minutes} мин.`;
  return minutes ? `${hours} ч. ${minutes} мин.` : `${hours} ч.`;
}

function portalUrl(pathname = '/') {
  const base = String(process.env.APP_BASE_URL || '').trim().replace(/\/$/, '');
  return base ? `${base}${pathname.startsWith('/') ? pathname : `/${pathname}`}` : '';
}

async function startDiscordBot() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.log('Discord-бот отключён: DISCORD_BOT_TOKEN не задан.');
    return;
  }

  try {
    const {
      Client,
      GatewayIntentBits,
      REST,
      Routes,
      SlashCommandBuilder,
      EmbedBuilder,
      ActivityType
    } = require('discord.js');

    discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });
    discordClient.portalEmbedBuilder = EmbedBuilder;

    discordClient.once('ready', async () => {
      try {
        console.log(`Discord-бот подключён: ${discordClient.user.tag}`);
        discordClient.user.setActivity('ивенты SCP:SL', { type: ActivityType.Watching });

        const commands = [
        new SlashCommandBuilder().setName('profile').setDescription('Показать моё досье администратора'),
        new SlashCommandBuilder().setName('warnings').setDescription('Показать мои активные взыскания'),
        new SlashCommandBuilder().setName('events').setDescription('Показать последние завершённые ивенты'),
        new SlashCommandBuilder().setName('event-top').setDescription('Показать рейтинг организаторов ивентов'),
        new SlashCommandBuilder().setName('event-active').setDescription('Показать активные ивенты'),
        new SlashCommandBuilder().setName('link').setDescription('Открыть портал для привязки Discord и Steam')
      ].map(command => command.toJSON());

      const applicationId = process.env.DISCORD_CLIENT_ID || discordClient.user.id;
      const rest = new REST({ version: '10' }).setToken(token);
      if (process.env.DISCORD_GUILD_ID) {
        await rest.put(
          Routes.applicationGuildCommands(applicationId, process.env.DISCORD_GUILD_ID),
          { body: commands }
        );
        console.log(`Discord-команды зарегистрированы для сервера ${process.env.DISCORD_GUILD_ID}.`);
      } else {
        await rest.put(Routes.applicationCommands(applicationId), { body: commands });
        console.log('Discord-команды зарегистрированы глобально.');
      }

        const eventChannel = await discordChannel(process.env.DISCORD_EVENT_CHANNEL_ID);
        if (process.env.DISCORD_EVENT_CHANNEL_ID && !eventChannel) {
          console.warn('Discord: канал ивентов недоступен. Проверьте DISCORD_EVENT_CHANNEL_ID и права бота.');
        }
      } catch (error) {
        console.error('Discord ready/setup:', error);
      }
    });

    discordClient.on('interactionCreate', async interaction => {
      if (!interaction.isChatInputCommand()) return;
      if (process.env.DISCORD_GUILD_ID && interaction.guildId !== process.env.DISCORD_GUILD_ID) {
        return interaction.reply({ content: 'Эта команда доступна только на привязанном сервере.', ephemeral: true });
      }

      try {
        const EmbedBuilder = discordClient.portalEmbedBuilder;

        if (interaction.commandName === 'link') {
          const url = portalUrl('/#profile');
          return interaction.reply({
            content: url
              ? `Открой личный кабинет и нажми **«Привязать Discord»**: ${url}`
              : 'Адрес портала пока не настроен. Укажите APP_BASE_URL в Railway.',
            ephemeral: true
          });
        }

        if (interaction.commandName === 'event-top') {
          const top = await all(`
            SELECT u.nickname, u.event_points,
              (SELECT COUNT(*) FROM events e WHERE e.host_user_id=u.id AND e.status='completed') AS event_count
            FROM users u
            WHERE u.approved=1
            ORDER BY u.event_points DESC, event_count DESC, u.nickname COLLATE NOCASE
            LIMIT 10
          `);
          const description = top.length
            ? top.map((user, index) => `${index + 1}. **${user.nickname}** — ${pointsLabel(user.event_points)} · ${user.event_count} ив.`).join('\n')
            : 'Рейтинг пока пуст.';
          const embed = new EmbedBuilder()
            .setTitle('РЕЙТИНГ ОРГАНИЗАТОРОВ')
            .setDescription(description)
            .setTimestamp();
          return interaction.reply({ embeds: [embed] });
        }

        if (interaction.commandName === 'events') {
          const events = await all(`
            SELECT e.name, e.duration_seconds, e.points_awarded, e.finished_at, u.nickname
            FROM events e
            LEFT JOIN users u ON u.id=e.host_user_id
            WHERE e.status='completed'
            ORDER BY e.id DESC
            LIMIT 10
          `);
          const description = events.length
            ? events.map(event => `• **${event.name}** — ${event.nickname || 'Неизвестно'} · ${durationLabel(event.duration_seconds)} · +${event.points_awarded}`).join('\n')
            : 'Завершённых ивентов пока нет.';
          const embed = new EmbedBuilder()
            .setTitle('ПОСЛЕДНИЕ ИВЕНТЫ')
            .setDescription(description)
            .setTimestamp();
          return interaction.reply({ embeds: [embed] });
        }

        if (interaction.commandName === 'event-active') {
          const events = await all(`
            SELECT e.name, e.server_id, e.started_at, u.nickname
            FROM events e
            LEFT JOIN users u ON u.id=e.host_user_id
            WHERE e.status='active'
            ORDER BY e.id DESC
            LIMIT 10
          `);
          const description = events.length
            ? events.map(event => {
                const started = Math.floor(new Date(event.started_at).getTime() / 1000);
                return `• **${event.name}** — ${event.nickname || 'Неизвестно'} · ${event.server_id} · <t:${started}:R>`;
              }).join('\n')
            : 'Сейчас активных ивентов нет.';
          const embed = new EmbedBuilder()
            .setTitle('АКТИВНЫЕ ИВЕНТЫ')
            .setDescription(description)
            .setTimestamp();
          return interaction.reply({ embeds: [embed] });
        }

        const user = await userByDiscordId(interaction.user.id);
        if (!user) {
          const url = portalUrl('/#profile');
          return interaction.reply({
            content: url
              ? `Discord не привязан к аккаунту портала. Выполни привязку здесь: ${url}`
              : 'Discord не привязан к аккаунту портала.',
            ephemeral: true
          });
        }

        if (interaction.commandName === 'profile') {
          const embed = new EmbedBuilder()
            .setTitle(`КАДРОВОЕ ДОСЬЕ · ${user.nickname}`)
            .addFields(
              { name: 'Должность', value: user.position || 'Не указана', inline: true },
              { name: 'Уровень допуска', value: String(user.access_level), inline: true },
              { name: 'Баллы', value: pointsLabel(user.event_points), inline: true },
              { name: 'Проведено ивентов', value: String(user.event_count), inline: true },
              { name: 'Общее время', value: durationLabel(user.total_event_seconds), inline: true },
              { name: 'Дисциплина', value: `Устные: ${user.verbal_warnings}/3\nСтрогие: ${user.strict_reprimands}/3`, inline: true }
            )
            .setTimestamp();
          if (user.discord_avatar) embed.setThumbnail(user.discord_avatar);
          return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        if (interaction.commandName === 'warnings') {
          const items = await all(`
            SELECT d.type, d.reason, d.comment, d.issued_at, issuer.nickname AS issuer_name
            FROM disciplinary_actions d
            LEFT JOIN users issuer ON issuer.id=d.issued_by
            WHERE d.user_id=? AND d.status='active'
            ORDER BY d.id DESC
          `, [user.id]);
          const description = items.length
            ? items.map(item => {
                const type = item.type === 'strict' ? 'Строгий выговор' : 'Устное предупреждение';
                const issuer = item.issuer_name ? ` · выдал ${item.issuer_name}` : '';
                return `• **${type}** — ${item.reason || 'Причина не указана'}${issuer}`;
              }).join('\n')
            : 'Активных взысканий нет.';
          const embed = new EmbedBuilder()
            .setTitle('МОИ ВЗЫСКАНИЯ')
            .setDescription(description)
            .setTimestamp();
          return interaction.reply({ embeds: [embed], ephemeral: true });
        }
      } catch (error) {
        console.error('Discord command:', error);
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content: 'Ошибка выполнения команды.', ephemeral: true }).catch(() => {});
        } else {
          await interaction.reply({ content: 'Ошибка выполнения команды.', ephemeral: true }).catch(() => {});
        }
      }
    });

    discordClient.on('error', error => console.error('Discord client:', error));
    await discordClient.login(token);
  } catch (error) {
    console.error('Не удалось запустить Discord-бота:', error);
    discordClient = null;
  }
}

async function discordChannel(channelId) {
  if (!discordClient?.isReady() || !channelId) return null;
  try {
    const channel = await discordClient.channels.fetch(channelId);
    return channel?.isTextBased() ? channel : null;
  } catch (error) {
    console.error('Discord channel:', error);
    return null;
  }
}

async function sendDiscordEventMessage(payload) {
  const channel = await discordChannel(process.env.DISCORD_EVENT_CHANNEL_ID);
  if (!channel) return null;
  try {
    return await channel.send(payload);
  } catch (error) {
    console.error('Discord event message:', error);
    return null;
  }
}

async function editDiscordEventMessage(messageId, payload) {
  if (!messageId) return null;
  const channel = await discordChannel(process.env.DISCORD_EVENT_CHANNEL_ID);
  if (!channel?.messages) return null;
  try {
    const message = await channel.messages.fetch(messageId);
    return await message.edit(payload);
  } catch (error) {
    console.warn(`Discord: не удалось обновить сообщение ${messageId}, будет отправлено новое.`, error.message);
    return null;
  }
}

async function sendDiscordAudit(text) {
  const channel = await discordChannel(process.env.DISCORD_LOG_CHANNEL_ID);
  if (!channel) return;
  await channel.send({ content: text, allowedMentions: { parse: [] } }).catch(error => {
    console.error('Discord audit channel:', error);
  });
}

function eventHostLabel(data) {
  return data.hostDiscordId ? `<@${data.hostDiscordId}>` : (data.hostName || 'Не определён');
}

async function notifyDiscordEventStarted(data) {
  if (!discordClient?.isReady()) return '';
  const EmbedBuilder = discordClient.portalEmbedBuilder;
  const startedTs = Math.floor(new Date(data.startedAt).getTime() / 1000);
  const embed = new EmbedBuilder()
    .setTitle('🟢 ПРОТОКОЛ ИВЕНТА АКТИВИРОВАН')
    .setDescription('**Мы вас ждём!**')
    .addFields(
      { name: 'Название ивента', value: data.eventName || 'Не указано', inline: false },
      { name: 'Проводящий', value: eventHostLabel(data), inline: true },
      { name: 'Сколько идёт', value: `<t:${startedTs}:R>`, inline: true },
      { name: 'Сервер', value: data.serverId, inline: true },
      { name: 'Статус', value: 'ИДЁТ', inline: true },
      { name: 'Начало', value: `<t:${startedTs}:F>`, inline: false }
    )
    .setFooter({ text: 'Foundation Portal' })
    .setTimestamp(new Date(data.startedAt));

  const message = await sendDiscordEventMessage({
    embeds: [embed],
    allowedMentions: data.hostDiscordId ? { users: [data.hostDiscordId] } : { parse: [] }
  });
  if (message) await sendDiscordAudit(`Ивент **${data.eventName}** запущен на сервере **${data.serverId}**.`);
  return message?.id || '';
}

async function notifyDiscordEventFinished(data) {
  if (!discordClient?.isReady()) return;
  const EmbedBuilder = discordClient.portalEmbedBuilder;
  const embed = new EmbedBuilder()
    .setTitle('🔴 ПРОТОКОЛ ИВЕНТА ЗАВЕРШЁН')
    .setDescription('Ивент завершён.')
    .addFields(
      { name: 'Название ивента', value: data.eventName || 'Не указано', inline: false },
      { name: 'Проводящий', value: eventHostLabel(data), inline: true },
      { name: 'Продолжительность', value: durationLabel(data.durationSeconds), inline: true },
      { name: 'Сервер', value: data.serverId, inline: true },
      { name: 'Статус', value: 'ЗАВЕРШЁН', inline: true }
    )
    .setFooter({ text: 'Foundation Portal' })
    .setTimestamp();

  const payload = {
    embeds: [embed],
    allowedMentions: data.hostDiscordId ? { users: [data.hostDiscordId] } : { parse: [] }
  };
  const edited = await editDiscordEventMessage(data.originalMessageId, payload);
  if (!edited) await sendDiscordEventMessage(payload);
  await sendDiscordAudit(`Ивент **${data.eventName}** завершён: ${durationLabel(data.durationSeconds)}.`);
}

async function notifyDiscordEventCancelled(data) {
  if (!discordClient?.isReady()) return;
  const EmbedBuilder = discordClient.portalEmbedBuilder;
  const embed = new EmbedBuilder()
    .setTitle('⚠️ ПРОТОКОЛ ИВЕНТА ОТМЕНЁН')
    .setDescription('Ивент был отменён.')
    .addFields(
      { name: 'Название ивента', value: data.eventName || 'Не указано', inline: false },
      { name: 'Сервер', value: data.serverId, inline: true },
      { name: 'Статус', value: 'ОТМЕНЁН', inline: true },
      { name: 'Причина', value: data.reason || 'Не указана', inline: false }
    )
    .setFooter({ text: 'Foundation Portal' })
    .setTimestamp();

  const payload = { embeds: [embed], allowedMentions: { parse: [] } };
  const edited = await editDiscordEventMessage(data.originalMessageId, payload);
  if (!edited) await sendDiscordEventMessage(payload);
  await sendDiscordAudit(`Ивент **${data.eventName}** отменён. Причина: ${data.reason || 'не указана'}.`);
}

io.use(async (socket, next) => {
  try {
    const cookie = socket.handshake.headers.cookie || '';
    const token = cookie.split(';').map(value => value.trim()).find(value => value.startsWith('session='))?.slice(8);
    if (!token) return next(new Error('unauthorized'));
    const payload = jwt.verify(decodeURIComponent(token), JWT_SECRET);
    const user = await userById(payload.id);
    if (!user) return next(new Error('unauthorized'));
    socket.user = user;
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

io.on('connection', async socket => {
  const memberships = await all('SELECT conversation_id FROM conversation_members WHERE user_id=?', [socket.user.id]);
  memberships.forEach(({ conversation_id: conversationId }) => socket.join(`conversation:${conversationId}`));

  socket.on('join_conversation', async conversationId => {
    const member = await get('SELECT 1 FROM conversation_members WHERE conversation_id=? AND user_id=?', [Number(conversationId), socket.user.id]);
    if (member) socket.join(`conversation:${Number(conversationId)}`);
  });

  socket.on('send_message', async (payload, callback = () => {}) => {
    try {
      const conversationId = Number(payload?.conversationId);
      const body = String(payload?.body || '').trim().slice(0, 2000);
      if (!conversationId || !body) return callback({ error: 'Пустое сообщение.' });
      const member = await get('SELECT 1 FROM conversation_members WHERE conversation_id=? AND user_id=?', [conversationId, socket.user.id]);
      if (!member) return callback({ error: 'Нет доступа к чату.' });
      const result = await run('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?, ?, ?)', [conversationId, socket.user.id, body]);
      const message = await get(`SELECT m.id, m.body, m.created_at, u.id AS sender_id, u.nickname, u.avatar
        FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=?`, [result.id]);
      io.to(`conversation:${conversationId}`).emit('new_message', { conversationId, message });
      callback({ ok: true });
    } catch (error) {
      console.error(error);
      callback({ error: 'Не удалось отправить сообщение.' });
    }
  });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Внутренняя ошибка сервера.' });
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDb().then(() => {
  server.listen(PORT, () => console.log(`Портал запущен: http://localhost:${PORT}`));
  startDiscordBot();
}).catch(error => {
  console.error('Ошибка инициализации:', error);
  process.exit(1);
});
