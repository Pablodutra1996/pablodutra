/**
 * Tempo real: chat (mensagens, digitando, presença) e sinalização WebRTC das videochamadas.
 * As chamadas são em malha (mesh) — ideal para equipes pequenas (até ~6 pessoas).
 */
import { Server } from 'socket.io';
import { q, now } from './db.js';
import { userFromToken, tokenFromCookieHeader } from './auth.js';

let io = null;
const online = new Map(); // userId -> Set(socketId)
const calls = new Map(); // channelId -> { startedAt, startedBy, peers: Map(socketId -> {user, cam, mic, screen}) }

export const emitAll = (event, data) => io?.emit(event, data);
export const emitToUser = (userId, event, data) => io?.to(`user:${userId}`).emit(event, data);
export const onlineUserIds = () => [...online.keys()];

/** Usuários que podem ver um canal (público = todos ativos; direto = membros) */
export async function channelAudience(channelId) {
  const ch = await q.get('SELECT * FROM channels WHERE id=?', channelId);
  if (!ch) return [];
  if (ch.type === 'public') return (await q.all(`SELECT id FROM users WHERE status='active'`)).map((u) => u.id);
  return (await q.all('SELECT user_id AS id FROM channel_members WHERE channel_id=?', channelId)).map((u) => u.id);
}

export async function canAccessChannel(userId, channelId) {
  return (await channelAudience(channelId)).includes(userId);
}

export async function emitToChannel(channelId, event, data) {
  for (const uid of await channelAudience(channelId)) emitToUser(uid, event, data);
}

export async function postSystemMessage(channelId, body) {
  const info = await q.run(`INSERT INTO messages (channel_id, user_id, body, kind, created_at) VALUES (?,?,?,'system',?)`, channelId, null, body, now());
  const msg = await q.get('SELECT * FROM messages WHERE id=?', info.lastInsertRowid);
  await emitToChannel(channelId, 'chat:message', msg);
}

const callSummary = () =>
  Object.fromEntries(
    [...calls.entries()].map(([cid, c]) => [cid, { startedAt: c.startedAt, participants: [...c.peers.values()].map((p) => p.user) }])
  );

function broadcastCallState() {
  emitAll('call:state', callSummary());
}

const logError = (where) => (err) => console.error(`[realtime] ${where}:`, err.message);

function leaveCall(socket) {
  const channelId = socket.data.callChannel;
  if (!channelId) return;
  const call = calls.get(channelId);
  socket.data.callChannel = null;
  socket.leave(`call:${channelId}`);
  if (!call) return;
  call.peers.delete(socket.id);
  socket.to(`call:${channelId}`).emit('call:peer-left', { socketId: socket.id });
  if (call.peers.size === 0) {
    calls.delete(channelId);
    const mins = Math.max(1, Math.round((Date.now() - new Date(call.startedAt).getTime()) / 60000));
    postSystemMessage(channelId, `📞 Chamada encerrada · duração aproximada de ${mins} min`).catch(logError('fim de chamada'));
  }
  broadcastCallState();
}

const touchUser = (id) => q.run('UPDATE users SET last_seen_at=? WHERE id=?', now(), id).catch(logError('last_seen'));

export function initRealtime(httpServer) {
  io = new Server(httpServer, { cors: { origin: false } });

  io.use(async (socket, next) => {
    try {
      const user = await userFromToken(tokenFromCookieHeader(socket.handshake.headers.cookie));
      if (!user) return next(new Error('unauthorized'));
      socket.data.user = { id: user.id, name: user.name, color: user.color };
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    socket.join(`user:${user.id}`);
    if (!online.has(user.id)) online.set(user.id, new Set());
    online.get(user.id).add(socket.id);
    touchUser(user.id);
    emitAll('presence', onlineUserIds());
    socket.emit('call:state', callSummary());

    socket.on('chat:typing', async ({ channelId }) => {
      try {
        const audience = await channelAudience(Number(channelId));
        if (!audience.includes(user.id)) return;
        for (const uid of audience) if (uid !== user.id) emitToUser(uid, 'chat:typing', { channelId: Number(channelId), user });
      } catch (err) { logError('typing')(err); }
    });

    // ---------- Videochamada ----------
    socket.on('call:join', async ({ channelId, cam, mic }, ack) => {
      try {
        channelId = Number(channelId);
        const audience = await channelAudience(channelId);
        if (!audience.includes(user.id)) return ack?.({ error: 'Sem acesso a este canal' });
        if (socket.data.callChannel) leaveCall(socket);

        let call = calls.get(channelId);
        const isNew = !call;
        if (!call) {
          call = { startedAt: now(), startedBy: user, peers: new Map() };
          calls.set(channelId, call);
        }
        const peers = [...call.peers.entries()].map(([socketId, info]) => ({ socketId, ...info }));
        call.peers.set(socket.id, { user, cam: !!cam, mic: !!mic, screen: false });
        socket.data.callChannel = channelId;
        socket.join(`call:${channelId}`);
        socket.to(`call:${channelId}`).emit('call:peer-joined', { socketId: socket.id, user, cam: !!cam, mic: !!mic });
        broadcastCallState();
        ack?.({ peers });

        if (isNew) {
          await postSystemMessage(channelId, `📞 ${user.name} iniciou uma chamada`);
          const ch = await q.get('SELECT * FROM channels WHERE id=?', channelId);
          for (const uid of audience) {
            if (uid !== user.id) emitToUser(uid, 'call:ring', { channelId, from: user, channelName: ch.type === 'public' ? `#${ch.name}` : null });
          }
        }
      } catch (err) {
        logError('call:join')(err);
        ack?.({ error: 'Falha ao entrar na chamada' });
      }
    });

    socket.on('call:signal', ({ to, data }) => {
      const channelId = socket.data.callChannel;
      if (!channelId || !calls.get(channelId)?.peers.has(to)) return;
      io.to(to).emit('call:signal', { from: socket.id, data });
    });

    socket.on('call:media', ({ cam, mic, screen }) => {
      const channelId = socket.data.callChannel;
      const peer = channelId && calls.get(channelId)?.peers.get(socket.id);
      if (!peer) return;
      Object.assign(peer, { cam: !!cam, mic: !!mic, screen: !!screen });
      socket.to(`call:${channelId}`).emit('call:media', { socketId: socket.id, cam: !!cam, mic: !!mic, screen: !!screen });
    });

    socket.on('call:decline', ({ channelId }) => {
      if (calls.get(Number(channelId))) io.to(`call:${channelId}`).emit('call:declined', { user });
    });

    socket.on('call:leave', () => leaveCall(socket));

    socket.on('disconnect', () => {
      leaveCall(socket);
      const set = online.get(user.id);
      set?.delete(socket.id);
      if (set && set.size === 0) online.delete(user.id);
      touchUser(user.id);
      emitAll('presence', onlineUserIds());
    });
  });

  return io;
}
