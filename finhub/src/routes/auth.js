import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { q, now, tx } from '../db.js';
import { config } from '../config.js';
import { setSession, clearSession, publicUser, requireAuth, loginRateLimit } from '../auth.js';
import { fail, isEmail, randomToken, pickColor } from '../util.js';
import { sendMail, layout } from '../mailer.js';

const r = Router();

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) fail(400, 'A senha deve ter pelo menos 8 caracteres.');
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) fail(400, 'A senha deve conter letras e números.');
}

r.get('/setup-status', (req, res) => {
  res.json({ needsSetup: q.get('SELECT COUNT(*) c FROM users').c === 0 });
});

// Primeiro acesso: cria o administrador e um quadro inicial
r.post('/setup', (req, res) => {
  if (q.get('SELECT COUNT(*) c FROM users').c > 0) fail(400, 'A plataforma já foi configurada.');
  const { name, email, password } = req.body || {};
  if (!name?.trim()) fail(400, 'Informe seu nome.');
  if (!isEmail(email)) fail(400, 'E-mail inválido.');
  if (config.adminEmail && email.trim().toLowerCase() !== config.adminEmail) {
    fail(403, 'Somente o e-mail definido como administrador (ADMIN_EMAIL) pode fazer a configuração inicial.');
  }
  validatePassword(password);
  const user = tx(() => {
    const info = q.run(
      `INSERT INTO users (name, email, password_hash, role, color, created_at) VALUES (?,?,?,?,?,?)`,
      name.trim(), email.trim().toLowerCase(), bcrypt.hashSync(password, 10), 'admin', pickColor(email), now()
    );
    q.run(`INSERT INTO boards (name, description, color, created_by, created_at) VALUES (?,?,?,?,?)`,
      'Rotinas Financeiras', 'Quadro principal da área financeira', '#4f46e5', info.lastInsertRowid, now());
    return q.get('SELECT * FROM users WHERE id=?', info.lastInsertRowid);
  });
  setSession(res, user);
  res.json({ user: publicUser(user) });
});

r.post('/login', loginRateLimit, (req, res) => {
  const { email, password } = req.body || {};
  const user = q.get('SELECT * FROM users WHERE email=?', String(email || '').trim());
  if (!user || !user.password_hash || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
    req.loginAttempt.fail();
    fail(401, 'E-mail ou senha incorretos.');
  }
  if (user.status !== 'active') fail(403, 'Usuário desativado. Fale com o administrador.');
  req.loginAttempt.ok();
  setSession(res, user);
  res.json({ user: publicUser(user) });
});

r.post('/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

r.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user), iceServers: config.webrtc.iceServers });
});

// ---------- Convites ----------
r.get('/invite/:token', (req, res) => {
  const inv = q.get('SELECT * FROM invites WHERE token=?', req.params.token);
  if (!inv || inv.accepted_at) fail(404, 'Convite inválido ou já utilizado.');
  if (inv.expires_at < now()) fail(410, 'Convite expirado. Peça um novo convite ao administrador.');
  res.json({ email: inv.email });
});

r.post('/accept-invite', (req, res) => {
  const { token, name, password } = req.body || {};
  const inv = q.get('SELECT * FROM invites WHERE token=?', String(token || ''));
  if (!inv || inv.accepted_at) fail(404, 'Convite inválido ou já utilizado.');
  if (inv.expires_at < now()) fail(410, 'Convite expirado.');
  if (!name?.trim()) fail(400, 'Informe seu nome.');
  validatePassword(password);
  if (q.get('SELECT id FROM users WHERE email=?', inv.email)) fail(409, 'Já existe uma conta com este e-mail.');
  const user = tx(() => {
    const info = q.run(
      `INSERT INTO users (name, email, password_hash, role, color, created_at) VALUES (?,?,?,?,?,?)`,
      name.trim(), inv.email.toLowerCase(), bcrypt.hashSync(password, 10), inv.role, pickColor(inv.email), now()
    );
    q.run('UPDATE invites SET accepted_at=? WHERE id=?', now(), inv.id);
    return q.get('SELECT * FROM users WHERE id=?', info.lastInsertRowid);
  });
  setSession(res, user);
  res.json({ user: publicUser(user) });
});

// ---------- Recuperação de senha ----------
r.post('/forgot', async (req, res) => {
  const user = q.get(`SELECT * FROM users WHERE email=? AND status='active'`, String(req.body?.email || '').trim());
  if (user) {
    const token = randomToken();
    q.run('INSERT INTO password_resets (user_id, token, expires_at, created_at) VALUES (?,?,?,?)',
      user.id, token, new Date(Date.now() + 2 * 3600000).toISOString(), now());
    await sendMail({
      to: user.email,
      subject: '[FinHub] Redefinição de senha',
      html: layout({
        title: 'Redefinir sua senha',
        intro: `Olá, ${user.name}. Recebemos um pedido para redefinir sua senha. O link vale por 2 horas. Se não foi você, ignore este e-mail.`,
        cta: { label: 'Criar nova senha', url: `${config.appUrl}/#/redefinir/${token}` },
      }),
    });
  }
  // Resposta idêntica para não revelar se o e-mail existe
  res.json({ ok: true });
});

r.post('/reset', (req, res) => {
  const { token, password } = req.body || {};
  const pr = q.get('SELECT * FROM password_resets WHERE token=?', String(token || ''));
  if (!pr || pr.used_at || pr.expires_at < now()) fail(400, 'Link inválido ou expirado.');
  validatePassword(password);
  q.run('UPDATE users SET password_hash=? WHERE id=?', bcrypt.hashSync(password, 10), pr.user_id);
  q.run('UPDATE password_resets SET used_at=? WHERE id=?', now(), pr.id);
  res.json({ ok: true });
});

r.post('/change-password', requireAuth, (req, res) => {
  const { current, password } = req.body || {};
  if (!bcrypt.compareSync(String(current || ''), req.user.password_hash)) fail(400, 'Senha atual incorreta.');
  validatePassword(password);
  q.run('UPDATE users SET password_hash=? WHERE id=?', bcrypt.hashSync(password, 10), req.user.id);
  res.json({ ok: true });
});

export default r;
