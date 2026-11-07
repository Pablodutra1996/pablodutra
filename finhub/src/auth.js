import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { q } from './db.js';

const COOKIE = 'finhub_token';
const SESSION_DAYS = 7;

export const publicUser = (u) =>
  u && {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    status: u.status,
    color: u.color,
    avatar_file_id: u.avatar_file_id || null,
    notify_email: !!u.notify_email,
    last_seen_at: u.last_seen_at,
    created_at: u.created_at,
  };

export function setSession(res, user) {
  const token = jwt.sign({ uid: user.id }, config.jwtSecret, { expiresIn: `${SESSION_DAYS}d` });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd && config.appUrl.startsWith('https'),
    maxAge: SESSION_DAYS * 86400000,
  });
}

export const clearSession = (res) => res.clearCookie(COOKIE);

export function userFromToken(token) {
  if (!token) return null;
  try {
    const { uid } = jwt.verify(token, config.jwtSecret);
    const user = q.get('SELECT * FROM users WHERE id = ?', uid);
    return user && user.status === 'active' ? user : null;
  } catch {
    return null;
  }
}

export function tokenFromCookieHeader(header = '') {
  const match = header.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${COOKIE}=`));
  return match ? decodeURIComponent(match.slice(COOKIE.length + 1)) : null;
}

export function requireAuth(req, res, next) {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const user = userFromToken(req.cookies?.[COOKIE] || bearer);
  if (!user) return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
  req.user = user;
  next();
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Apenas administradores podem fazer isso.' });
  next();
}

// Proteção simples contra força bruta no login
const attempts = new Map();
export function loginRateLimit(req, res, next) {
  const key = `${req.ip}:${String(req.body?.email || '').toLowerCase()}`;
  const entry = attempts.get(key) || { count: 0, until: 0 };
  if (entry.until > Date.now()) {
    return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' });
  }
  req.loginAttempt = {
    fail() {
      entry.count += 1;
      if (entry.count >= 8) {
        entry.until = Date.now() + 10 * 60000;
        entry.count = 0;
      }
      attempts.set(key, entry);
    },
    ok() {
      attempts.delete(key);
    },
  };
  next();
}
