import crypto from 'node:crypto';
import { config } from './config.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const fail = (status, message) => {
  throw new HttpError(status, message);
};

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

export const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

const COLORS = ['#6264a7', '#0f6cbd', '#00a37a', '#c4314b', '#e97548', '#8764b8', '#0b8a8a', '#ca5010', '#4f6bed', '#a4262c'];
export const pickColor = (seed) => COLORS[Math.abs([...String(seed)].reduce((a, c) => a + c.charCodeAt(0), 0)) % COLORS.length];

/** Converte valor vindo do cliente em ISO-UTC (ou null). Datas sem hora viram fim do dia local. */
export function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  let v = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) v = `${v}T23:59:00${config.tzOffset}`;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) fail(400, `Data inválida: ${value}`);
  return d.toISOString();
}

/** Início/fim de um mês 'YYYY-MM' no fuso configurado, em ISO-UTC. */
export function monthRange(month) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) fail(400, 'Mês inválido (use AAAA-MM)');
  const [y, m] = month.split('-').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  const start = new Date(`${y}-${pad(m)}-01T00:00:00${config.tzOffset}`);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const end = new Date(`${ny}-${pad(nm)}-01T00:00:00${config.tzOffset}`);
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Mês corrente (ou deslocado) no fuso configurado: 'YYYY-MM' */
export function monthKey(offset = 0, from = new Date()) {
  const local = new Date(from.getTime() + parseOffsetMinutes(config.tzOffset) * 60000);
  const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + offset, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function parseOffsetMinutes(off) {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(off);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

export function formatDateBR(iso, withTime = true) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', {
    timeZone: config.timezone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const MONTH_NAMES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
export const monthLabel = (month) => {
  const [y, m] = month.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]}/${y}`;
};
