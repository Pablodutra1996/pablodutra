/** Cliente HTTP da API e estado global compartilhado */
export const state = {
  user: null,
  users: [],
  online: new Set(),
  meta: null,
  boards: [],
  socket: null,
  iceServers: [],
  calls: {},
  unreadChat: 0,
};

const listeners = new Map();
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}
export function emit(event, data) {
  listeners.get(event)?.forEach((fn) => fn(data));
}

export async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (form) opts.body = form;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, opts);
  let data = {};
  try { data = await res.json(); } catch { /* resposta vazia */ }
  if (res.status === 401 && !path.startsWith('/auth/')) {
    state.user = null;
    location.hash = '#/login';
  }
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

export const userById = (id) => state.users.find((u) => u.id === id);
export const activeUsers = () => state.users.filter((u) => u.status === 'active');
export const isAdmin = () => state.user?.role === 'admin';
