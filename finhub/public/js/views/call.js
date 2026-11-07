/**
 * Videochamada WebRTC em malha (mesh), sinalizada via Socket.IO.
 * - Câmera e microfone podem ser ligados/desligados a qualquer momento
 * - Entrada "só áudio" (câmera desabilitada) e compartilhamento de tela
 * - Cada conexão sempre negocia 1 transceptor de áudio + 1 de vídeo, então ligar a câmera
 *   depois não exige renegociar (usa replaceTrack).
 */
import { state, emit } from '../api.js';
import { $, esc, avatar, icon, toast } from '../util.js';

let call = null; // { channelId, title, local, audioTrack, videoTrack, screenTrack, cam, mic, peers: Map, minimized }

export const inCall = (channelId) => call && (channelId === undefined || call.channelId === channelId);

export function initCalls() {
  const s = state.socket;
  s.on('call:state', (calls) => { state.calls = calls; emit('calls'); });
  s.on('call:ring', ({ channelId, from, channelName }) => {
    if (call) return;
    showRing(channelId, from, channelName);
  });
  s.on('call:peer-joined', (p) => {
    if (!call) return;
    createPeer(p.socketId, p, false);
    toast(`${p.user.name} entrou na chamada`);
  });
  s.on('call:peer-left', ({ socketId }) => removePeer(socketId));
  s.on('call:signal', handleSignal);
  s.on('call:media', ({ socketId, cam, mic, screen }) => {
    const p = call?.peers.get(socketId);
    if (!p) return;
    Object.assign(p.info, { cam, mic, screen });
    renderTiles();
  });
  s.on('call:declined', ({ user }) => call && toast(`${user.name} recusou a chamada`));
  window.addEventListener('beforeunload', () => call && s.emit('call:leave'));
}

function showRing(channelId, from, channelName) {
  document.querySelector('.ring')?.remove();
  const el = document.createElement('div');
  el.className = 'ring';
  el.innerHTML = `<div class="row">${avatar(from, 42)}<div><b>${esc(from.name)}</b><div class="muted small">está chamando${channelName ? ` em ${esc(channelName)}` : ' você'}…</div></div></div>
    <div class="row" style="margin-top:14px;justify-content:flex-end">
      <button class="btn danger sm" data-a="decline">Recusar</button>
      <button class="btn sm" data-a="audio">${icon('phone', 14)} Áudio</button>
      <button class="btn success sm" data-a="video">${icon('video', 14)} Vídeo</button></div>`;
  document.body.appendChild(el);
  playRingtone(el);
  const timer = setTimeout(() => el.remove(), 30000);
  el.querySelectorAll('[data-a]').forEach((b) => (b.onclick = () => {
    clearTimeout(timer);
    el.remove();
    if (b.dataset.a === 'decline') return state.socket.emit('call:decline', { channelId });
    startCall(channelId, { video: b.dataset.a === 'video', title: channelName || from.name });
  }));
}

function playRingtone(el) {
  try {
    const ctx = new AudioContext();
    let n = 0;
    const beep = () => {
      if (!el.isConnected || n++ > 10) return ctx.close();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 660;
      g.gain.value = 0.06;
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.35);
      setTimeout(beep, 1800);
    };
    beep();
  } catch { /* sem áudio */ }
}

async function getMedia(video) {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: video ? { width: 1280, height: 720 } : false });
  } catch (err) {
    if (video) {
      toast('Câmera indisponível — entrando só com áudio.', 'error');
      return getMedia(false);
    }
    try {
      toast('Microfone indisponível — você entrará apenas ouvindo.', 'error');
      return new MediaStream();
    } catch { throw err; }
  }
}

export async function startCall(channelId, { video = true, title = 'Chamada' } = {}) {
  if (call) {
    if (call.channelId === channelId) return setMinimized(false);
    return toast('Você já está em outra chamada. Encerre-a primeiro.', 'error');
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return toast('Seu navegador bloqueou câmera/microfone. Acesse a plataforma via HTTPS.', 'error');
  }
  const local = await getMedia(video);
  call = {
    channelId, title, local,
    audioTrack: local.getAudioTracks()[0] || null,
    videoTrack: local.getVideoTracks()[0] || null,
    screenTrack: null,
    peers: new Map(),
    minimized: false,
    startedAt: Date.now(),
  };
  call.cam = !!call.videoTrack;
  call.mic = !!call.audioTrack;
  renderOverlay();
  state.socket.emit('call:join', { channelId, cam: call.cam, mic: call.mic }, (res) => {
    if (res?.error) { toast(res.error, 'error'); return hangup(); }
    // Quem entra inicia a negociação com quem já está na sala
    for (const p of res.peers) createPeer(p.socketId, p, true);
  });
}

function createPeer(socketId, info, initiator) {
  if (call.peers.has(socketId)) return call.peers.get(socketId);
  const pc = new RTCPeerConnection({ iceServers: state.iceServers });
  const peer = { pc, info: { user: info.user, cam: info.cam, mic: info.mic, screen: info.screen }, stream: new MediaStream(), pending: [] };
  call.peers.set(socketId, peer);

  pc.onicecandidate = (e) => e.candidate && state.socket.emit('call:signal', { to: socketId, data: { candidate: e.candidate } });
  pc.ontrack = (e) => {
    peer.stream.getTracks().filter((t) => t.kind === e.track.kind).forEach((t) => peer.stream.removeTrack(t));
    peer.stream.addTrack(e.track);
    renderTiles();
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') toast(`Falha de conexão com ${peer.info.user?.name || 'participante'}. Se persistir, configure um servidor TURN.`, 'error');
  };

  if (initiator) {
    pc.addTransceiver(call.audioTrack || 'audio', { direction: 'sendrecv', streams: [call.local] });
    pc.addTransceiver(currentVideoTrack() || 'video', { direction: 'sendrecv', streams: [call.local] });
    pc.createOffer()
      .then((o) => pc.setLocalDescription(o))
      .then(() => state.socket.emit('call:signal', { to: socketId, data: { sdp: pc.localDescription } }));
  }
  renderTiles();
  return peer;
}

async function handleSignal({ from, data }) {
  if (!call) return;
  const peer = call.peers.get(from) || createPeer(from, { user: { name: 'Participante' } }, false);
  const { pc } = peer;
  try {
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        for (const tr of pc.getTransceivers()) {
          const kind = tr.receiver.track.kind;
          tr.direction = 'sendrecv';
          await tr.sender.replaceTrack(kind === 'audio' ? call.audioTrack : currentVideoTrack());
          tr.sender.setStreams?.(call.local);
        }
        await pc.setLocalDescription(await pc.createAnswer());
        state.socket.emit('call:signal', { to: from, data: { sdp: pc.localDescription } });
      }
      for (const c of peer.pending.splice(0)) await pc.addIceCandidate(c);
    } else if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
      else peer.pending.push(data.candidate);
    }
  } catch (err) {
    console.error('[call] sinalização', err);
  }
}

const currentVideoTrack = () => call.screenTrack || (call.cam ? call.videoTrack : null);
const videoSenders = () => [...call.peers.values()].map((p) => p.pc.getTransceivers().find((t) => t.receiver.track.kind === 'video')?.sender).filter(Boolean);

async function refreshVideoSenders() {
  const track = currentVideoTrack();
  await Promise.all(videoSenders().map((s) => s.replaceTrack(track)));
  broadcastMedia();
  renderTiles();
  renderControls();
}

const broadcastMedia = () => state.socket.emit('call:media', { cam: call.cam, mic: call.mic, screen: !!call.screenTrack });

async function toggleCam() {
  if (call.cam) {
    call.cam = false;
    call.videoTrack?.stop();
    if (call.videoTrack) call.local.removeTrack(call.videoTrack);
    call.videoTrack = null;
  } else {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
      call.videoTrack = s.getVideoTracks()[0];
      call.local.addTrack(call.videoTrack);
      call.cam = true;
    } catch {
      return toast('Não foi possível acessar a câmera.', 'error');
    }
  }
  await refreshVideoSenders();
}

async function toggleMic() {
  if (!call.audioTrack) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      call.audioTrack = s.getAudioTracks()[0];
      call.local.addTrack(call.audioTrack);
      await Promise.all([...call.peers.values()].map((p) =>
        p.pc.getTransceivers().find((t) => t.receiver.track.kind === 'audio')?.sender.replaceTrack(call.audioTrack)));
      call.mic = true;
    } catch { return toast('Não foi possível acessar o microfone.', 'error'); }
  } else {
    call.mic = !call.mic;
    call.audioTrack.enabled = call.mic;
  }
  broadcastMedia();
  renderControls();
  renderTiles();
}

async function toggleScreen() {
  if (call.screenTrack) {
    call.screenTrack.stop();
    call.screenTrack = null;
  } else {
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
      call.screenTrack = s.getVideoTracks()[0];
      call.screenTrack.onended = () => { if (call?.screenTrack) { call.screenTrack = null; refreshVideoSenders(); } };
    } catch { return; }
  }
  await refreshVideoSenders();
}

function removePeer(socketId) {
  const p = call?.peers.get(socketId);
  if (!p) return;
  p.pc.close();
  call.peers.delete(socketId);
  toast(`${p.info.user?.name || 'Participante'} saiu da chamada`);
  renderTiles();
}

export function hangup() {
  if (!call) return;
  state.socket.emit('call:leave');
  for (const p of call.peers.values()) p.pc.close();
  call.local.getTracks().forEach((t) => t.stop());
  call.screenTrack?.stop();
  clearInterval(call.timer);
  call = null;
  $('#call-root').innerHTML = '';
  emit('calls');
}

function setMinimized(v) {
  if (!call) return;
  call.minimized = v;
  $('.call-overlay')?.classList.toggle('min', v);
  renderControls();
}

function renderOverlay() {
  $('#call-root').innerHTML = `<div class="call-overlay">
    <div class="call-top">${icon('video', 18)} <b>${esc(call.title)}</b><span class="t muted" id="call-timer" style="color:#a5a8c8">00:00</span>
      <div class="spacer"></div><span class="small t" style="color:#a5a8c8" id="call-count"></span></div>
    <div class="video-grid" id="video-grid"></div>
    <div class="call-controls" id="call-controls"></div></div>`;
  call.timer = setInterval(() => {
    const s = Math.floor((Date.now() - call.startedAt) / 1000);
    const el = $('#call-timer');
    if (el) el.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
  renderControls();
  renderTiles();
}

function renderControls() {
  const el = $('#call-controls');
  if (!el || !call) return;
  el.innerHTML = `
    <button class="call-btn ${call.mic ? '' : 'off'}" data-c="mic" title="${call.mic ? 'Desativar microfone' : 'Ativar microfone'}">${icon(call.mic ? 'mic' : 'micOff')}</button>
    <button class="call-btn ${call.cam ? '' : 'off'}" data-c="cam" title="${call.cam ? 'Desligar câmera' : 'Ligar câmera'}">${icon(call.cam ? 'video' : 'videoOff')}</button>
    ${navigator.mediaDevices.getDisplayMedia ? `<button class="call-btn ${call.screenTrack ? 'off' : ''}" data-c="screen" title="Compartilhar tela">${icon('screen')}</button>` : ''}
    <button class="call-btn" data-c="min" title="${call.minimized ? 'Expandir' : 'Minimizar e voltar à plataforma'}">${icon(call.minimized ? 'maximize' : 'minimize')}</button>
    <button class="call-btn hang" data-c="hang" title="Sair da chamada">${icon('hang')}</button>`;
  const actions = { mic: toggleMic, cam: toggleCam, screen: toggleScreen, min: () => setMinimized(!call.minimized), hang: hangup };
  el.querySelectorAll('[data-c]').forEach((b) => (b.onclick = () => actions[b.dataset.c]()));
}

function tile({ id, user, stream, cam, mic, screen, local }) {
  const showVideo = cam || screen;
  return `<div class="tile ${local ? 'local' : ''} ${screen ? 'screen' : ''}" data-tile="${id}">
    <video autoplay playsinline ${local ? 'muted' : ''} style="${showVideo ? '' : 'visibility:hidden'}"></video>
    ${showVideo ? '' : `<div class="avatar-big">${avatar(user, 84)}</div>`}
    <div class="label">${mic ? '' : icon('micOff', 14)} ${esc(user?.name || '')}${local ? ' (você)' : ''}${screen ? ' · tela' : ''}</div></div>`;
}

function renderTiles() {
  const grid = $('#video-grid');
  if (!grid || !call) return;
  const items = [
    { id: 'local', user: state.user, stream: new MediaStream(currentVideoTrack() ? [currentVideoTrack()] : []), cam: call.cam, mic: call.mic, screen: !!call.screenTrack, local: true },
    ...[...call.peers.entries()].map(([sid, p]) => ({ id: sid, user: p.info.user, stream: p.stream, cam: p.info.cam, mic: p.info.mic, screen: p.info.screen })),
  ];
  grid.innerHTML = items.map(tile).join('');
  items.forEach((it) => {
    const v = grid.querySelector(`[data-tile="${CSS.escape(it.id)}"] video`);
    if (v) { v.srcObject = it.stream; v.play?.().catch(() => {}); }
  });
  const count = $('#call-count');
  if (count) count.textContent = `${items.length} participante(s)`;
}
