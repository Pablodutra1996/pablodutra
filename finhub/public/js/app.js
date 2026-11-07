import { state, api, emit, on, isAdmin } from './api.js';
import { $, esc, avatar, icon, parseHash, relTime, toast } from './util.js';
import { renderAuth } from './views/auth.js';
import { renderDashboard } from './views/dashboard.js';
import { renderBoards, renderBoard } from './views/boards.js';
import { renderMyTasks } from './views/mytasks.js';
import { openTask } from './views/task-modal.js';
import { renderChat } from './views/chat.js';
import { renderImports } from './views/imports.js';
import { renderTeam } from './views/team.js';
import { renderProfile } from './views/profile.js';
import { initCalls } from './views/call.js';

const PUBLIC = ['login', 'setup', 'convite', 'esqueci', 'redefinir'];
const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { id: 'quadros', label: 'Quadros', icon: 'boards' },
  { id: 'minhas-tarefas', label: 'Minhas tarefas', icon: 'checksq' },
  { id: 'chat', label: 'Chat', icon: 'chat' },
  { id: 'importacoes', label: 'Importações', icon: 'import' },
];
const VIEWS = {
  dashboard: { title: 'Dashboard de indicadores', render: renderDashboard },
  quadros: { title: 'Quadros', render: renderBoards },
  quadro: { title: 'Quadro', render: renderBoard },
  'minhas-tarefas': { title: 'Minhas tarefas', render: renderMyTasks },
  tarefa: { title: 'Minhas tarefas', render: renderMyTasks, nav: 'minhas-tarefas' },
  chat: { title: 'Chat', render: renderChat, flush: true },
  importacoes: { title: 'Importar tarefas', render: renderImports },
  equipe: { title: 'Equipe e convites', render: renderTeam, admin: true },
  perfil: { title: 'Meu perfil', render: renderProfile },
};

let cleanup = null;
let notifUnread = 0;

async function loadSession() {
  try {
    const { user, iceServers } = await api('/auth/me');
    state.user = user;
    state.iceServers = iceServers;
    const [{ users, online }, meta] = await Promise.all([api('/users'), api('/tasks/meta')]);
    state.users = users;
    state.online = new Set(online);
    state.meta = meta;
    connectSocket();
    return true;
  } catch {
    state.user = null;
    return false;
  }
}

function connectSocket() {
  if (state.socket) return;
  const socket = window.io({ withCredentials: true });
  state.socket = socket;
  socket.on('presence', (ids) => { state.online = new Set(ids); emit('presence'); });
  socket.on('task:changed', (d) => emit('task:changed', d));
  socket.on('task:deleted', (d) => emit('task:deleted', d));
  socket.on('boards:changed', () => emit('boards:changed'));
  socket.on('users:changed', ({ user }) => {
    const i = state.users.findIndex((u) => u.id === user.id);
    if (i >= 0) state.users[i] = user; else state.users.push(user);
    if (user.id === state.user.id) Object.assign(state.user, user);
    const me = $('.sidebar .me .avatar');
    if (me && user.id === state.user.id) me.outerHTML = avatar(state.user, 34, true);
    emit('users:changed', user);
  });
  socket.on('chat:message', (m) => {
    emit('chat:message', m);
    if (m.user_id !== state.user.id && !location.hash.startsWith(`#/chat/${m.channel_id}`)) refreshChatBadge();
  });
  socket.on('chat:typing', (d) => emit('chat:typing', d));
  socket.on('chat:channels-changed', () => emit('chat:channels-changed'));
  socket.on('notification', (n) => {
    notifUnread++;
    updateBell();
    toast(n.title);
  });
  socket.on('connect_error', (e) => e.message === 'unauthorized' && (location.hash = '#/login'));
  initCalls();
}

export async function refreshChatBadge() {
  try {
    const { channels } = await api('/chat/channels');
    state.unreadChat = channels.reduce((s, c) => s + c.unread, 0);
    const b = $('#chat-badge');
    if (b) { b.textContent = state.unreadChat; b.classList.toggle('hidden', !state.unreadChat); }
  } catch { /* ignora */ }
}
on('chat:read', refreshChatBadge);

function updateBell() {
  const b = $('#bell-badge');
  if (b) { b.textContent = notifUnread; b.classList.toggle('hidden', !notifUnread); }
}

function renderLayout(active, title) {
  const navItem = (n) => `<a class="nav-item ${active === n.id ? 'active' : ''}" href="#/${n.id}">${icon(n.icon)}<span>${n.label}</span>
    ${n.id === 'chat' ? `<span class="badge hidden" id="chat-badge">0</span>` : ''}</a>`;
  $('#app').innerHTML = `
  <div class="layout">
    <aside class="sidebar">
      <div class="logo"><span class="logo-mark">F</span> FinHub</div>
      ${NAV.map(navItem).join('')}
      ${isAdmin() ? `<div class="nav-section">Administração</div>${navItem({ id: 'equipe', label: 'Equipe e convites', icon: 'users' })}` : ''}
      <a class="me" href="#/perfil">${avatar(state.user, 34, true)}<div style="min-width:0"><div class="name">${esc(state.user.name)}</div>
        <div class="small" style="color:#a5a8e6">${state.user.role === 'admin' ? 'Administrador' : 'Membro'}</div></div></a>
    </aside>
    <div class="main">
      <header class="topbar" style="position:relative">
        <h1 id="page-title">${esc(title)}</h1>
        <div class="spacer"></div>
        <div id="topbar-actions" class="row"></div>
        <button class="btn ghost icon" id="bell" title="Notificações" style="position:relative">${icon('bell')}
          <span class="badge hidden" id="bell-badge" style="position:absolute;top:0;right:-2px">0</span></button>
        <button class="btn ghost icon" id="logout" title="Sair">${icon('logout')}</button>
      </header>
      <section class="content" id="view"></section>
    </div>
  </div>`;
  $('#logout').onclick = async () => {
    await api('/auth/logout', { method: 'POST' });
    state.socket?.disconnect();
    state.socket = null;
    state.user = null;
    location.hash = '#/login';
  };
  $('#bell').onclick = toggleNotifications;
  updateBell();
  refreshChatBadge();
}

async function toggleNotifications() {
  const existing = $('#notif-dd');
  if (existing) return existing.remove();
  const { items } = await api('/notifications');
  const dd = document.createElement('div');
  dd.className = 'dropdown';
  dd.id = 'notif-dd';
  dd.innerHTML = `<div class="row" style="padding:12px 14px;border-bottom:1px solid var(--line)"><b>Notificações</b><div class="spacer"></div>
    <button class="btn ghost sm" id="read-all">Marcar como lidas</button></div>
    ${items.length ? items.map((n) => `<div class="notif ${n.read_at ? '' : 'unread'}" data-link="${esc(n.link || '')}">
      <div style="font-weight:600">${esc(n.title)}</div><div class="muted small" style="margin-top:2px">${esc(n.body || '')}</div>
      <div class="muted small" style="margin-top:4px">${relTime(n.created_at)}</div></div>`).join('') : '<div class="empty">Nenhuma notificação</div>'}`;
  $('.topbar').appendChild(dd);
  dd.querySelector('#read-all').onclick = async () => {
    await api('/notifications/read-all', { method: 'POST' });
    notifUnread = 0;
    updateBell();
    dd.remove();
  };
  dd.querySelectorAll('.notif').forEach((el) => (el.onclick = () => { dd.remove(); if (el.dataset.link) location.hash = el.dataset.link; }));
  setTimeout(() => document.addEventListener('click', function close(e) {
    if (!dd.contains(e.target) && e.target.id !== 'bell') { dd.remove(); document.removeEventListener('click', close); }
  }), 0);
}

async function route() {
  const { parts, query } = parseHash();
  const name = parts[0] || 'dashboard';
  if (typeof cleanup === 'function') { try { cleanup(); } catch { /* ignore */ } }
  cleanup = null;
  $('#modals').innerHTML = '';

  if (PUBLIC.includes(name)) {
    if (state.user && name === 'login') return (location.hash = '#/dashboard');
    return renderAuth($('#app'), name, parts[1]);
  }
  if (!state.user && !(await loadSession())) return (location.hash = '#/login');

  const view = VIEWS[name] || VIEWS.dashboard;
  if (view.admin && !isAdmin()) return (location.hash = '#/dashboard');
  renderLayout(view.nav || (name === 'quadro' ? 'quadros' : name), view.title);
  const container = $('#view');
  if (view.flush) container.classList.add('flush');
  cleanup = await view.render(container, parts.slice(1), query);
  if (name === 'tarefa' && parts[1]) openTask(Number(parts[1]), { onClose: () => history.replaceState(null, '', '#/minhas-tarefas') });

  api('/notifications').then(({ unread }) => { notifUnread = unread; updateBell(); }).catch(() => {});
}

export function setTitle(t) {
  const el = $('#page-title');
  if (el) el.textContent = t;
}
export function setActions(html) {
  const el = $('#topbar-actions');
  if (el) el.innerHTML = html;
  return el;
}
export async function afterLogin() {
  await loadSession();
  location.hash = '#/dashboard';
}

window.addEventListener('hashchange', route);
window.addEventListener('load', route);
