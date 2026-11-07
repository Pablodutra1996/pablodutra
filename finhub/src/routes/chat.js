import { Router } from 'express';
import { q, now } from '../db.js';
import { fail } from '../util.js';
import { upload, saveFile } from '../services.js';
import { canAccessChannel, emitToChannel, emitAll } from '../realtime.js';

const r = Router();

const MSG_SELECT = `SELECT m.*, u.name user_name, u.color user_color, f.filename file_name, f.mime file_mime, f.size file_size
  FROM messages m LEFT JOIN users u ON u.id=m.user_id LEFT JOIN files f ON f.id=m.file_id`;

function assertAccess(userId, channelId) {
  if (!canAccessChannel(userId, channelId)) fail(403, 'Sem acesso a este canal.');
}

r.get('/channels', (req, res) => {
  const uid = req.user.id;
  const channels = q.all(`
    SELECT c.*,
      (SELECT last_read_at FROM channel_members cm WHERE cm.channel_id=c.id AND cm.user_id=?) last_read_at,
      (SELECT MAX(created_at) FROM messages m WHERE m.channel_id=c.id) last_message_at
    FROM channels c
    WHERE c.type='public' OR c.id IN (SELECT channel_id FROM channel_members WHERE user_id=?)
    ORDER BY c.type DESC, c.name`, uid, uid);
  for (const c of channels) {
    c.unread = q.get(`SELECT COUNT(*) n FROM messages WHERE channel_id=? AND (user_id IS NULL OR user_id!=?) AND created_at > ?`,
      c.id, uid, c.last_read_at || '').n;
    if (c.type === 'direct') {
      const other = q.get(`SELECT u.id, u.name, u.color FROM channel_members cm JOIN users u ON u.id=cm.user_id
        WHERE cm.channel_id=? AND cm.user_id!=?`, c.id, uid);
      c.other = other || { id: uid, name: req.user.name, color: req.user.color };
    }
  }
  res.json({ channels });
});

r.post('/channels', (req, res) => {
  const name = String(req.body?.name || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '');
  if (!name) fail(400, 'Nome de canal inválido.');
  if (q.get(`SELECT id FROM channels WHERE type='public' AND name=?`, name)) fail(409, 'Já existe um canal com este nome.');
  const info = q.run(`INSERT INTO channels (name, type, created_by, created_at) VALUES (?, 'public', ?, ?)`, name, req.user.id, now());
  emitAll('chat:channels-changed', {});
  res.json({ channel: q.get('SELECT * FROM channels WHERE id=?', info.lastInsertRowid) });
});

// Abre (ou cria) conversa direta com um colega
r.post('/dm', (req, res) => {
  const otherId = Number(req.body?.user_id);
  if (!q.get(`SELECT id FROM users WHERE id=? AND status='active'`, otherId)) fail(400, 'Usuário inválido.');
  const key = [req.user.id, otherId].sort((a, b) => a - b).join(':');
  let ch = q.get('SELECT * FROM channels WHERE dm_key=?', key);
  if (!ch) {
    const info = q.run(`INSERT INTO channels (type, dm_key, created_by, created_at) VALUES ('direct', ?, ?, ?)`, key, req.user.id, now());
    for (const uid of new Set([req.user.id, otherId])) {
      q.run('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?,?)', info.lastInsertRowid, uid);
    }
    ch = q.get('SELECT * FROM channels WHERE id=?', info.lastInsertRowid);
    emitToChannel(ch.id, 'chat:channels-changed', {});
  }
  res.json({ channel: ch });
});

r.get('/channels/:id/messages', (req, res) => {
  const channelId = Number(req.params.id);
  assertAccess(req.user.id, channelId);
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const messages = q.all(`${MSG_SELECT} WHERE m.channel_id=? AND m.id < ? ORDER BY m.id DESC LIMIT 60`, channelId, before).reverse();
  res.json({ messages });
});

r.post('/channels/:id/messages', upload.single('file'), async (req, res) => {
  const channelId = Number(req.params.id);
  assertAccess(req.user.id, channelId);
  const body = String(req.body?.body || '').trim().slice(0, 8000);
  if (!body && !req.file) fail(400, 'Mensagem vazia.');
  const fileId = req.file ? await saveFile(req.file, { prefix: `chat/${channelId}`, userId: req.user.id }) : null;
  const info = q.run('INSERT INTO messages (channel_id, user_id, body, file_id, created_at) VALUES (?,?,?,?,?)',
    channelId, req.user.id, body, fileId, now());
  q.run(`INSERT INTO channel_members (channel_id, user_id, last_read_at) VALUES (?,?,?)
         ON CONFLICT(channel_id, user_id) DO UPDATE SET last_read_at=excluded.last_read_at`, channelId, req.user.id, now());
  const msg = q.get(`${MSG_SELECT} WHERE m.id=?`, info.lastInsertRowid);
  emitToChannel(channelId, 'chat:message', msg);
  res.json({ message: msg });
});

r.post('/channels/:id/read', (req, res) => {
  const channelId = Number(req.params.id);
  assertAccess(req.user.id, channelId);
  q.run(`INSERT INTO channel_members (channel_id, user_id, last_read_at) VALUES (?,?,?)
         ON CONFLICT(channel_id, user_id) DO UPDATE SET last_read_at=excluded.last_read_at`, channelId, req.user.id, now());
  res.json({ ok: true });
});

export default r;
