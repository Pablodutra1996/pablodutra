/**
 * Indicadores da área financeira.
 *
 *  Taxa de conclusão ........ % das tarefas com prazo no mês que estão concluídas
 *  Entregas no prazo ........ % das tarefas concluídas no mês até a data de vencimento
 *  Lead time médio .......... tempo entre a criação e a conclusão (tarefas concluídas no mês)
 *  Cycle time médio ......... tempo entre o início da execução ("Em Andamento") e a conclusão
 *  Tempo médio por etapa .... tempo médio em A Fazer / Em Andamento / Aguardando Terceiros
 *  Atraso médio ............. para as entregas fora do prazo, quanto passou do vencimento
 *  Em atraso ................ tarefas abertas com prazo vencido no fechamento do mês (ou agora)
 *  Reaberturas .............. conclusões rejeitadas (evidência insuficiente) no mês
 *  Throughput semanal ....... concluídas por semana
 *  + quebras por categoria, prioridade e responsável e tendência dos últimos 6 meses
 */
import { q, now } from './db.js';
import { monthRange, monthKey } from './util.js';
import { STATUSES, CATEGORIES, PRIORITIES } from './config.js';

const H = 3600000;
const hoursBetween = (a, b) => (new Date(b) - new Date(a)) / H;
const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null);
const pct = (num, den) => (den ? Math.round((num / den) * 1000) / 10 : null);
const round1 = (x) => (x === null ? null : Math.round(x * 10) / 10);
const inRange = (iso, s, e) => iso && iso >= s && iso < e;

function loadData(userId) {
  const tasks = userId
    ? q.all(`SELECT t.*, u.name assignee_name FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id WHERE t.assignee_id=?`, userId)
    : q.all(`SELECT t.*, u.name assignee_name FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id`);
  const ids = new Set(tasks.map((t) => t.id));
  const history = q.all('SELECT * FROM task_history ORDER BY task_id, created_at, id').filter((h) => ids.has(h.task_id));
  const byTask = new Map();
  for (const h of history) {
    if (!byTask.has(h.task_id)) byTask.set(h.task_id, []);
    byTask.get(h.task_id).push(h);
  }
  return { tasks, history, byTask };
}

/** Horas que a tarefa passou em cada status até `until` */
function timeInStatus(task, events, until) {
  const out = {};
  const evs = events?.length ? events : [{ to_status: 'todo', created_at: task.created_at }];
  for (let i = 0; i < evs.length; i++) {
    const st = evs[i].to_status;
    if (st === 'done') continue;
    const end = i + 1 < evs.length ? evs[i + 1].created_at : until;
    out[st] = (out[st] || 0) + Math.max(0, hoursBetween(evs[i].created_at, end));
  }
  return out;
}

function core(tasks, byTask, history, start, end) {
  const cutoff = end < now() ? end : now();
  const created = tasks.filter((t) => inRange(t.created_at, start, end));
  const completed = tasks.filter((t) => t.status === 'done' && inRange(t.completed_at, start, end));
  const dueInMonth = tasks.filter((t) => inRange(t.due_date, start, end));
  const dueDone = dueInMonth.filter((t) => t.status === 'done');
  const onTime = completed.filter((t) => !t.due_date || t.completed_at <= t.due_date);
  const late = completed.filter((t) => t.due_date && t.completed_at > t.due_date);
  // abertas e vencidas no fechamento do período
  const overdueOpen = tasks.filter((t) => t.due_date && t.due_date < cutoff && t.created_at < cutoff &&
    (t.status !== 'done' || t.completed_at > cutoff));
  const cycle = completed.map((t) => {
    const firstDoing = (byTask.get(t.id) || []).find((h) => h.to_status === 'doing');
    return hoursBetween(firstDoing?.created_at || t.started_at || t.created_at, t.completed_at);
  });
  const statusTotals = {};
  const statusCounts = {};
  for (const t of completed) {
    const tis = timeInStatus(t, byTask.get(t.id), t.completed_at);
    for (const [st, h] of Object.entries(tis)) {
      statusTotals[st] = (statusTotals[st] || 0) + h;
      statusCounts[st] = (statusCounts[st] || 0) + 1;
    }
  }
  const reopened = history.filter((h) => h.from_status === 'done' && h.to_status !== 'done' && inRange(h.created_at, start, end)).length;

  return {
    created: created.length,
    completed: completed.length,
    due_in_period: dueInMonth.length,
    due_completed: dueDone.length,
    completion_rate: pct(dueDone.length, dueInMonth.length),
    on_time_rate: pct(onTime.length, completed.length),
    on_time: onTime.length,
    late: late.length,
    avg_lead_time_h: round1(avg(completed.map((t) => hoursBetween(t.created_at, t.completed_at)))),
    avg_cycle_time_h: round1(avg(cycle)),
    avg_delay_h: round1(avg(late.map((t) => hoursBetween(t.due_date, t.completed_at)))),
    overdue_open: overdueOpen.length,
    open_now: tasks.filter((t) => t.status !== 'done' && t.created_at < cutoff).length,
    reopened,
    time_in_status_h: Object.fromEntries(
      STATUSES.filter((s) => s.id !== 'done').map((s) => [s.id, round1(statusCounts[s.id] ? statusTotals[s.id] / statusCounts[s.id] : null)])
    ),
    _lists: { completed, overdueOpen },
  };
}

export function computeKpis(month, userId = null) {
  const { start, end } = monthRange(month);
  const { tasks, history, byTask } = loadData(userId);
  const base = core(tasks, byTask, history, start, end);
  const { completed, overdueOpen } = base._lists;
  delete base._lists;

  // Throughput semanal (semanas iniciando na segunda-feira, dentro do mês)
  const weekly = {};
  for (const t of completed) {
    const d = new Date(t.completed_at);
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const key = monday.toISOString().slice(0, 10);
    weekly[key] = (weekly[key] || 0) + 1;
  }

  const byCategory = [...CATEGORIES, null].map((cat) => {
    const ts = tasks.filter((t) => (t.category || null) === cat);
    const k = core(ts, byTask, history, start, end);
    return { category: cat || 'Sem categoria', created: k.created, completed: k.completed, overdue_open: k.overdue_open,
      completion_rate: k.completion_rate, avg_lead_time_h: k.avg_lead_time_h };
  }).filter((c) => c.created || c.completed || c.overdue_open);

  const byPriority = PRIORITIES.map((p) => {
    const k = core(tasks.filter((t) => t.priority === p), byTask, history, start, end);
    return { priority: p, completed: k.completed, on_time_rate: k.on_time_rate, overdue_open: k.overdue_open };
  });

  let byAssignee = [];
  if (!userId) {
    const users = q.all(`SELECT id, name, color FROM users WHERE status='active' ORDER BY name`);
    byAssignee = users.map((u) => {
      const k = core(tasks.filter((t) => t.assignee_id === u.id), byTask, history, start, end);
      return { user_id: u.id, name: u.name, color: u.color, completed: k.completed, completion_rate: k.completion_rate,
        on_time_rate: k.on_time_rate, avg_lead_time_h: k.avg_lead_time_h, avg_cycle_time_h: k.avg_cycle_time_h,
        overdue_open: k.overdue_open, open_now: k.open_now, reopened: k.reopened };
    });
  }

  // Tendência dos últimos 6 meses
  const trend = [];
  for (let i = 5; i >= 0; i--) {
    const m = shiftMonth(month, -i);
    const rg = monthRange(m);
    const k = core(tasks, byTask, history, rg.start, rg.end);
    trend.push({ month: m, completed: k.completed, created: k.created, completion_rate: k.completion_rate, on_time_rate: k.on_time_rate });
  }

  return {
    month,
    scope: userId ? 'user' : 'team',
    user_id: userId,
    generated_at: now(),
    summary: base,
    weekly_throughput: Object.entries(weekly).sort().map(([week, count]) => ({ week, count })),
    by_category: byCategory,
    by_priority: byPriority,
    by_assignee: byAssignee,
    trend,
    overdue_tasks: overdueOpen
      .filter((t) => t.status !== 'done')
      .sort((a, b) => a.due_date.localeCompare(b.due_date))
      .slice(0, 25)
      .map((t) => ({ id: t.id, title: t.title, due_date: t.due_date, assignee_name: t.assignee_name, category: t.category, priority: t.priority })),
  };
}

export function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export const currentMonth = () => monthKey(0);
export const previousMonth = () => monthKey(-1);

export function formatHours(h) {
  if (h === null || h === undefined) return '—';
  if (h < 24) return `${h.toFixed(1).replace('.', ',')} h`;
  return `${(h / 24).toFixed(1).replace('.', ',')} dias`;
}
