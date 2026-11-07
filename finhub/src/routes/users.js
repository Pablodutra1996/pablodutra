import { Router } from 'express';
import { q, now } from '../db.js';
import { config } from '../config.js';
import { requireAdmin, publicUser } from '../auth.js';
import { fail, isEmail, randomToken, escapeHtml } from '../util.js';
import { sendMail, layout } from '../mailer.js';
import { onlineUserIds, emitAll } from '../realtime.js';
import { upload, saveFile } from '../services.js';
import { getStorage } from '../storage.js';

const r = Router();
const INVITE_DAYS = 7;
const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// ---------- Foto de perfil ----------
r.post('/me/avatar', upload.single('avatar'), async (req, res) => {
  const file = req.file;
  if (!file) fail(400, 'Envie uma imagem.');
  if (!AVATAR_TYPES.includes(file.mimetype)) fail(400, 'Formato não suportado. Use JPG, PNG ou WEBP.');
  if (file.size > 2 * 1024 * 1024) fail(400, 'A foto deve ter no máximo 2 MB.');
  const fileId = await saveFile(file, { prefix: `avatars/${req.user.id}`, userId: req.user.id });
  q.run('UPDATE users SET avatar_file_id=? WHERE id=?', fileId, req.user.id);
  const user = publicUser(q.get('SELECT * FROM users WHERE id=?', req.user.id));
  emitAll('users:changed', { user });
  res.json({ user });
});

r.delete('/me/avatar', (req, res) => {
  q.run('UPDATE users SET avatar_file_id=NULL WHERE id=?', req.user.id);
  const user = publicUser(q.get('SELECT * FROM users WHERE id=?', req.user.id));
  emitAll('users:changed', { user });
  res.json({ user });
});

r.get('/:id/avatar', async (req, res) => {
  const row = q.get('SELECT f.* FROM users u JOIN files f ON f.id=u.avatar_file_id WHERE u.id=?', req.params.id);
  if (!row) fail(404, 'Sem foto.');
  const stream = await (await getStorage()).getStream(row.storage_key);
  res.setHeader('Content-Type', row.mime);
  res.setHeader('Cache-Control', 'private, max-age=86400'); // URL muda (?v=) quando a foto muda
  res.setHeader('X-Content-Type-Options', 'nosniff');
  stream.on('error', () => res.status(404).end());
  stream.pipe(res);
});

r.get('/', (req, res) => {
  const users = q.all(`SELECT * FROM users ORDER BY name`).map(publicUser);
  res.json({ users, online: onlineUserIds() });
});

r.patch('/me', (req, res) => {
  const { name, notify_email } = req.body || {};
  if (name !== undefined && !String(name).trim()) fail(400, 'Nome não pode ficar vazio.');
  q.run('UPDATE users SET name=COALESCE(?, name), notify_email=COALESCE(?, notify_email) WHERE id=?',
    name?.trim() ?? null, notify_email === undefined ? null : notify_email ? 1 : 0, req.user.id);
  res.json({ user: publicUser(q.get('SELECT * FROM users WHERE id=?', req.user.id)) });
});

// ---------- Administração ----------
async function sendInviteEmail(inv, inviter) {
  return sendMail({
    to: inv.email,
    subject: '[FinHub] Você foi convidado para a plataforma da área financeira',
    html: layout({
      title: 'Você recebeu um convite',
      intro: `${escapeHtml(inviter.name)} convidou você para participar do <b>FinHub</b>, a plataforma de gestão de tarefas, chat e indicadores da área financeira.<br><br>Clique no botão abaixo para criar seu login e senha. O convite vale por ${INVITE_DAYS} dias.`,
      cta: { label: 'Aceitar convite e criar senha', url: `${config.appUrl}/#/convite/${inv.token}` },
    }),
  });
}

r.get('/invites', requireAdmin, (req, res) => {
  res.json({
    invites: q.all(`SELECT i.*, u.name invited_by_name FROM invites i LEFT JOIN users u ON u.id=i.invited_by
                    WHERE i.accepted_at IS NULL ORDER BY i.created_at DESC`),
  });
});

r.post('/invite', requireAdmin, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const role = req.body?.role === 'admin' ? 'admin' : 'member';
  if (!isEmail(email)) fail(400, 'E-mail inválido.');
  if (q.get('SELECT id FROM users WHERE email=?', email)) fail(409, 'Este e-mail já possui conta.');
  q.run('DELETE FROM invites WHERE email=? AND accepted_at IS NULL', email);
  const token = randomToken();
  const info = q.run('INSERT INTO invites (email, role, token, invited_by, expires_at, created_at) VALUES (?,?,?,?,?,?)',
    email, role, token, req.user.id, new Date(Date.now() + INVITE_DAYS * 86400000).toISOString(), now());
  const inv = q.get('SELECT * FROM invites WHERE id=?', info.lastInsertRowid);
  const sent = await sendInviteEmail(inv, req.user);
  res.json({ invite: inv, sent, link: `${config.appUrl}/#/convite/${token}` });
});

r.post('/invites/:id/resend', requireAdmin, async (req, res) => {
  const inv = q.get('SELECT * FROM invites WHERE id=? AND accepted_at IS NULL', req.params.id);
  if (!inv) fail(404, 'Convite não encontrado.');
  q.run('UPDATE invites SET expires_at=? WHERE id=?', new Date(Date.now() + INVITE_DAYS * 86400000).toISOString(), inv.id);
  const sent = await sendInviteEmail(inv, req.user);
  res.json({ sent, link: `${config.appUrl}/#/convite/${inv.token}` });
});

r.delete('/invites/:id', requireAdmin, (req, res) => {
  q.run('DELETE FROM invites WHERE id=? AND accepted_at IS NULL', req.params.id);
  res.json({ ok: true });
});

r.patch('/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const target = q.get('SELECT * FROM users WHERE id=?', id);
  if (!target) fail(404, 'Usuário não encontrado.');
  const { role, status } = req.body || {};
  if (id === req.user.id && (role === 'member' || status === 'disabled')) fail(400, 'Você não pode rebaixar ou desativar a si mesmo.');
  if (role && !['admin', 'member'].includes(role)) fail(400, 'Perfil inválido.');
  if (status && !['active', 'disabled'].includes(status)) fail(400, 'Status inválido.');
  q.run('UPDATE users SET role=COALESCE(?, role), status=COALESCE(?, status) WHERE id=?', role ?? null, status ?? null, id);
  res.json({ user: publicUser(q.get('SELECT * FROM users WHERE id=?', id)) });
});

export default r;
