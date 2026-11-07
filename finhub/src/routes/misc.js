import { Router } from 'express';
import { q, now } from '../db.js';
import { fail } from '../util.js';
import { getStorage } from '../storage.js';
import { canAccessChannel } from '../realtime.js';

/** Download de arquivos (com checagem de acesso) e central de notificações */
const r = Router();

r.get('/files/:id', async (req, res) => {
  const file = await q.get('SELECT * FROM files WHERE id=?', req.params.id);
  if (!file) fail(404, 'Arquivo não encontrado.');
  // Arquivos do chat: só quem tem acesso ao canal
  const msg = await q.get('SELECT channel_id FROM messages WHERE file_id=?', file.id);
  if (msg && !(await canAccessChannel(req.user.id, msg.channel_id))) fail(403, 'Sem acesso a este arquivo.');
  const stream = await (await getStorage()).getStream(file.storage_key);
  const inline = req.query.download !== '1' && /^(image\/|application\/pdf|text\/plain)/.test(file.mime || '');
  res.setHeader('Content-Type', file.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  stream.on('error', () => res.status(404).end());
  stream.pipe(res);
});

r.get('/notifications', async (req, res) => {
  const items = await q.all('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50', req.user.id);
  const unread = (await q.get('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read_at IS NULL', req.user.id)).n;
  res.json({ items, unread });
});

r.post('/notifications/read-all', async (req, res) => {
  await q.run('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL', now(), req.user.id);
  res.json({ ok: true });
});

export default r;
