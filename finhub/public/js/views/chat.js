import { state, api, on, emit, activeUsers } from '../api.js';
import { $, $$, esc, avatar, icon, toast, fmtTime, fmtSize, promptDialog } from '../util.js';
import { startCall, inCall } from './call.js';

export async function renderChat(container, [channelParam]) {
  let channels = [];
  let current = null;
  let messages = [];
  let typingTimer = null;
  let lastTypingSent = 0;

  container.innerHTML = `<div class="chat">
    <div class="chat-list" id="chat-list"></div>
    <div class="chat-main" id="chat-main"><div class="empty" style="margin:auto">Selecione uma conversa</div></div>
  </div>`;

  const channelTitle = (c) => (c.type === 'public' ? `# ${c.name}` : c.other?.name || 'Conversa');

  async function loadChannels() {
    ({ channels } = await api('/chat/channels'));
    drawList();
  }

  function drawList() {
    const pub = channels.filter((c) => c.type === 'public');
    const dmsByUser = new Map(channels.filter((c) => c.type === 'direct').map((c) => [c.other?.id, c]));
    const others = activeUsers().filter((u) => u.id !== state.user.id);
    $('#chat-list', container).innerHTML = `
      <div class="row" style="padding:4px 10px 6px"><b class="small muted" style="text-transform:uppercase;letter-spacing:.05em">Canais</b><div class="spacer"></div>
        <button class="btn ghost sm" id="new-channel" title="Novo canal">${icon('plus', 14)}</button></div>
      ${pub.map((c) => `<div class="chat-item ${current?.id === c.id ? 'active' : ''} ${c.unread ? 'unread' : ''}" data-ch="${c.id}">
        ${icon('hash', 16)}<span class="name">${esc(c.name)}</span>
        ${state.calls[c.id] ? `<span title="Chamada em andamento" style="color:var(--ok)">${icon('video', 14)}</span>` : ''}
        ${c.unread ? `<span class="badge">${c.unread}</span>` : ''}</div>`).join('')}
      <div style="padding:16px 10px 6px"><b class="small muted" style="text-transform:uppercase;letter-spacing:.05em">Mensagens diretas</b></div>
      ${others.map((u) => {
        const c = dmsByUser.get(u.id);
        return `<div class="chat-item ${c && current?.id === c.id ? 'active' : ''} ${c?.unread ? 'unread' : ''}" data-user="${u.id}">
          ${avatar(u, 26, state.online.has(u.id))}<span class="name">${esc(u.name)}</span>
          ${c && state.calls[c.id] ? `<span style="color:var(--ok)">${icon('video', 14)}</span>` : ''}
          ${c?.unread ? `<span class="badge">${c.unread}</span>` : ''}</div>`;
      }).join('') || '<div class="muted small" style="padding:6px 10px">Convide colegas em "Equipe e convites".</div>'}`;
    $$('[data-ch]', container).forEach((el) => (el.onclick = () => (location.hash = `#/chat/${el.dataset.ch}`)));
    $$('[data-user]', container).forEach((el) => (el.onclick = async () => {
      const { channel } = await api('/chat/dm', { method: 'POST', body: { user_id: Number(el.dataset.user) } });
      if (!channels.find((c) => c.id === channel.id)) await loadChannels();
      location.hash = `#/chat/${channel.id}`;
    }));
    $('#new-channel', container).onclick = async () => {
      const name = await promptDialog('Novo canal', 'Nome do canal', { placeholder: 'ex.: fechamento-mensal', ok: 'Criar' });
      if (!name) return;
      try { const { channel } = await api('/chat/channels', { method: 'POST', body: { name } }); await loadChannels(); location.hash = `#/chat/${channel.id}`; } catch (e) { toast(e.message, 'error'); }
    };
  }

  function msgHtml(m, prev) {
    if (m.kind === 'system') return `<div class="msg system">${esc(m.body)} · ${fmtTime(m.created_at)}</div>`;
    const day = new Date(m.created_at).toDateString();
    const sep = !prev || new Date(prev.created_at).toDateString() !== day
      ? `<div class="day-sep">${new Date(m.created_at).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' })}</div>` : '';
    const cont = !sep && prev && prev.kind !== 'system' && prev.user_id === m.user_id && new Date(m.created_at) - new Date(prev.created_at) < 5 * 60000;
    const isImg = m.file_mime?.startsWith('image/');
    const file = m.file_id ? (isImg
      ? `<a href="/api/files/${m.file_id}" target="_blank" rel="noopener"><img class="preview" src="/api/files/${m.file_id}" alt="${esc(m.file_name)}"></a>`
      : `<a class="file" href="/api/files/${m.file_id}?download=1">${icon('file', 16)} ${esc(m.file_name)} <span class="muted small">${fmtSize(m.file_size || 0)}</span></a>`) : '';
    return `${sep}<div class="msg ${cont ? 'cont' : ''}">${avatar({ id: m.user_id, name: m.user_name, color: m.user_color }, 34)}
      <div class="body">${cont ? '' : `<div class="who">${esc(m.user_name)} <span class="muted small" style="font-weight:400">${fmtTime(m.created_at)}</span></div>`}
      ${m.body ? `<div class="text">${linkify(esc(m.body))}</div>` : ''}${file}</div></div>`;
  }
  const linkify = (s) => s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');

  function drawMessages(scroll = true) {
    const box = $('#messages', container);
    if (!box) return;
    box.innerHTML = messages.map((m, i) => msgHtml(m, messages[i - 1])).join('') ||
      '<div class="empty">Nenhuma mensagem ainda. Diga olá! 👋</div>';
    if (scroll) box.scrollTop = box.scrollHeight;
  }

  function drawCallBanner() {
    const el = $('#call-banner', container);
    if (!el || !current) return;
    const call = state.calls[current.id];
    if (call && !inCall(current.id)) {
      el.className = 'call-banner';
      el.innerHTML = `${icon('video', 16)} <b>Chamada em andamento</b> · ${call.participants.map((p) => esc(p.name)).join(', ')}<div class="spacer"></div>
        <button class="btn success sm" data-join="video">Entrar com vídeo</button><button class="btn sm" data-join="audio">Só áudio</button>`;
      $$('[data-join]', el).forEach((b) => (b.onclick = () => startCall(current.id, { video: b.dataset.join === 'video', title: channelTitle(current) })));
    } else {
      el.className = 'hidden';
      el.innerHTML = '';
    }
  }

  async function openChannel(id) {
    current = channels.find((c) => c.id === id);
    if (!current) return;
    const main = $('#chat-main', container);
    const sub = current.type === 'direct'
      ? (state.online.has(current.other?.id) ? '<span style="color:var(--ok)">● Online</span>' : 'Offline')
      : `${activeUsers().length} membros`;
    main.innerHTML = `
      <div class="chat-head">${current.type === 'direct' ? avatar(current.other, 34, state.online.has(current.other?.id)) : `<span class="logo-mark" style="width:34px;height:34px">${icon('hash', 16)}</span>`}
        <div><div style="font-weight:700">${esc(channelTitle(current))}</div><div class="small muted">${sub}</div></div>
        <div class="spacer"></div>
        <button class="btn" id="call-audio" title="Chamada de áudio">${icon('phone', 16)} Áudio</button>
        <button class="btn primary" id="call-video" title="Videochamada">${icon('video', 16)} Vídeo</button>
      </div>
      <div id="call-banner" class="hidden"></div>
      <div class="messages" id="messages"><div class="empty">Carregando…</div></div>
      <div class="typing" id="typing"></div>
      <form class="composer" id="composer">
        <button type="button" class="btn ghost icon" id="attach" title="Anexar arquivo">${icon('clip')}</button>
        <input type="file" id="file" hidden>
        <textarea class="input" id="text" rows="1" placeholder="Escreva uma mensagem… (Enter envia, Shift+Enter quebra linha)"></textarea>
        <button class="btn primary icon" type="submit" title="Enviar">${icon('send', 18)}</button>
      </form>`;
    $('#call-video', main).onclick = () => startCall(current.id, { video: true, title: channelTitle(current) });
    $('#call-audio', main).onclick = () => startCall(current.id, { video: false, title: channelTitle(current) });
    drawCallBanner();
    drawList();

    ({ messages } = await api(`/chat/channels/${id}/messages`));
    drawMessages();
    markRead();

    const box = $('#messages', main);
    box.onscroll = async () => {
      if (box.scrollTop > 0 || !messages.length || box.dataset.loading) return;
      box.dataset.loading = '1';
      const { messages: older } = await api(`/chat/channels/${id}/messages?before=${messages[0].id}`);
      if (older.length) {
        const h = box.scrollHeight;
        messages = [...older, ...messages];
        drawMessages(false);
        box.scrollTop = box.scrollHeight - h;
      }
      delete box.dataset.loading;
    };

    const text = $('#text', main);
    const send = async (file) => {
      const body = text.value.trim();
      if (!body && !file) return;
      const fd = new FormData();
      fd.append('body', body);
      if (file) fd.append('file', file);
      text.value = '';
      text.style.height = '';
      try { await api(`/chat/channels/${id}/messages`, { method: 'POST', form: fd }); } catch (e) { toast(e.message, 'error'); text.value = body; }
    };
    $('#composer', main).onsubmit = (e) => { e.preventDefault(); send(); };
    text.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
    text.oninput = () => {
      text.style.height = 'auto';
      text.style.height = `${Math.min(160, text.scrollHeight)}px`;
      if (Date.now() - lastTypingSent > 2500) { state.socket?.emit('chat:typing', { channelId: id }); lastTypingSent = Date.now(); }
    };
    $('#attach', main).onclick = () => $('#file', main).click();
    $('#file', main).onchange = (e) => { const f = e.target.files[0]; if (f) send(f); e.target.value = ''; };
    text.focus();
  }

  async function markRead() {
    if (!current) return;
    await api(`/chat/channels/${current.id}/read`, { method: 'POST' });
    const c = channels.find((x) => x.id === current.id);
    if (c) c.unread = 0;
    drawList();
    emit('chat:read');
  }

  await loadChannels();
  const target = Number(channelParam) || channels.find((c) => c.type === 'public')?.id;
  if (target) await openChannel(target);

  const offs = [
    on('chat:message', (m) => {
      if (current && m.channel_id === current.id) {
        messages.push(m);
        const box = $('#messages', container);
        const nearBottom = box && box.scrollHeight - box.scrollTop - box.clientHeight < 200;
        drawMessages(nearBottom || m.user_id === state.user.id);
        $('#typing', container).textContent = '';
        if (document.hasFocus()) markRead();
      } else {
        const c = channels.find((x) => x.id === m.channel_id);
        if (c) { if (m.user_id !== state.user.id) c.unread++; drawList(); } else loadChannels();
      }
    }),
    on('chat:typing', ({ channelId, user }) => {
      if (current?.id !== channelId) return;
      const el = $('#typing', container);
      el.textContent = `${user.name} está digitando…`;
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => (el.textContent = ''), 3000);
    }),
    on('chat:channels-changed', loadChannels),
    on('presence', drawList),
    on('calls', () => { drawList(); drawCallBanner(); }),
  ];
  return () => offs.forEach((o) => o());
}
