import { q, now } from './db.js';
import { config, STATUSES } from './config.js';
import { computeKpis, formatHours } from './kpis.js';
import { sendMail, layout } from './mailer.js';
import { escapeHtml, monthLabel, formatDateBR } from './util.js';

const fmtPct = (v) => (v === null || v === undefined ? '—' : `${String(v).replace('.', ',')}%`);
const cell = 'padding:8px 10px;border-bottom:1px solid #eef0f4;font-size:14px';

function kpiTable(s) {
  const rows = [
    ['Taxa de conclusão (tarefas com prazo no mês)', `${fmtPct(s.completion_rate)} <span style="color:#6b7280">(${s.due_completed}/${s.due_in_period})</span>`],
    ['Tarefas concluídas no mês', s.completed],
    ['Entregas no prazo', `${fmtPct(s.on_time_rate)} <span style="color:#6b7280">(${s.on_time} no prazo · ${s.late} com atraso)</span>`],
    ['Tempo médio de conclusão (lead time)', formatHours(s.avg_lead_time_h)],
    ['Tempo médio de execução (cycle time)', formatHours(s.avg_cycle_time_h)],
    ['Atraso médio das entregas fora do prazo', formatHours(s.avg_delay_h)],
    ['Tarefas criadas no mês', s.created],
    ['Tarefas em atraso no fechamento', s.overdue_open],
    ['Reaberturas (evidência rejeitada)', s.reopened],
    ...STATUSES.filter((st) => st.id !== 'done').map((st) => [`Tempo médio em "${st.label}"`, formatHours(s.time_in_status_h[st.id])]),
  ];
  return `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:8px 0 16px">
    ${rows.map(([k, v]) => `<tr><td style="${cell};color:#374151">${k}</td><td style="${cell};font-weight:600;text-align:right">${v}</td></tr>`).join('')}
  </table>`;
}

function assigneeTable(list) {
  if (!list.length) return '';
  return `<h3 style="font-size:16px;margin:20px 0 6px">Por responsável</h3>
  <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
    <tr style="background:#f3f4f8"><th align="left" style="${cell}">Pessoa</th><th style="${cell}">Concluídas</th><th style="${cell}">Conclusão</th><th style="${cell}">No prazo</th><th style="${cell}">Em atraso</th></tr>
    ${list.map((a) => `<tr><td style="${cell}">${escapeHtml(a.name)}</td><td align="center" style="${cell}">${a.completed}</td>
      <td align="center" style="${cell}">${fmtPct(a.completion_rate)}</td><td align="center" style="${cell}">${fmtPct(a.on_time_rate)}</td>
      <td align="center" style="${cell}">${a.overdue_open}</td></tr>`).join('')}
  </table>`;
}

function overdueList(tasks) {
  if (!tasks.length) return '<p style="color:#047857">✔ Nenhuma tarefa em atraso. Excelente!</p>';
  return `<h3 style="font-size:16px;margin:20px 0 6px">Tarefas em atraso</h3><ul style="padding-left:18px;margin:0">
    ${tasks.slice(0, 10).map((t) => `<li style="margin:4px 0"><a href="${config.appUrl}/#/tarefa/${t.id}" style="color:#4f46e5">${escapeHtml(t.title)}</a>
      — venceu em ${formatDateBR(t.due_date, false)}${t.assignee_name ? ` · ${escapeHtml(t.assignee_name)}` : ''}</li>`).join('')}
  </ul>`;
}

/** Gera e envia o resumo mensal: cada pessoa recebe seus indicadores; administradores recebem também o consolidado da equipe */
export async function sendMonthlyReports(month, { onlyUserId } = {}) {
  const team = computeKpis(month, null);
  q.run('INSERT INTO kpi_reports (period, user_id, data, sent_at, created_at) VALUES (?,?,?,?,?)', month, null, JSON.stringify(team), now(), now());
  const users = q.all(`SELECT * FROM users WHERE status='active'${onlyUserId ? ' AND id=?' : ''}`, ...(onlyUserId ? [onlyUserId] : []));
  let sent = 0;
  for (const u of users) {
    const mine = computeKpis(month, u.id);
    q.run('INSERT INTO kpi_reports (period, user_id, data, sent_at, created_at) VALUES (?,?,?,?,?)', month, u.id, JSON.stringify(mine), now(), now());
    const s = mine.summary;
    const highlight = s.completion_rate === null ? 'Não houve tarefas com prazo no período.'
      : s.completion_rate >= 90 ? '🎉 Ótimo resultado! Continue assim.'
      : s.completion_rate >= 70 ? 'Bom resultado, com espaço para melhorar a pontualidade.'
      : 'Atenção: a taxa de conclusão ficou abaixo do esperado. Vale revisar prioridades e prazos.';
    const body = `
      <h3 style="font-size:16px;margin:8px 0 6px">Seus indicadores</h3>
      <p style="margin:0 0 8px;color:#374151">${highlight}</p>
      ${kpiTable(s)}
      ${overdueList(mine.overdue_tasks)}
      ${u.role === 'admin' ? `<hr style="border:none;border-top:2px solid #eef0f4;margin:24px 0">
        <h3 style="font-size:16px;margin:8px 0 6px">Consolidado da equipe</h3>${kpiTable(team.summary)}${assigneeTable(team.by_assignee)}${overdueList(team.overdue_tasks)}` : ''}`;
    const ok = await sendMail({
      to: u.email,
      subject: `[FinHub] Resumo de indicadores · ${monthLabel(month)}`,
      html: layout({
        title: `Resumo mensal · ${monthLabel(month)}`,
        intro: `Olá, ${escapeHtml(u.name.split(' ')[0])}! Aqui está o resumo dos indicadores de tarefas da área financeira referentes a <b>${monthLabel(month)}</b>.`,
        body,
        cta: { label: 'Abrir dashboard completo', url: `${config.appUrl}/#/dashboard?mes=${month}` },
      }),
    });
    if (ok) sent++;
  }
  return { sent, total: users.length };
}

/** Lembretes: tarefas vencendo em breve (1x) e vencidas (repetido até a conclusão) — um e-mail por pessoa */
export async function sendTaskReminders() {
  const nowIso = now();
  const soonLimit = new Date(Date.now() + config.reminders.dueSoonHours * 3600000).toISOString();
  const repeatBefore = new Date(Date.now() - (config.reminders.overdueEveryHours - 0.5) * 3600000).toISOString();

  const overdue = q.all(`SELECT * FROM tasks WHERE status!='done' AND assignee_id IS NOT NULL AND due_date < ?
    AND (last_overdue_notice_at IS NULL OR last_overdue_notice_at < ?)`, nowIso, repeatBefore);
  const soon = q.all(`SELECT * FROM tasks WHERE status!='done' AND assignee_id IS NOT NULL AND due_date >= ? AND due_date <= ?
    AND due_soon_notice_at IS NULL`, nowIso, soonLimit);

  const byUser = new Map();
  const add = (t, kind) => {
    if (!byUser.has(t.assignee_id)) byUser.set(t.assignee_id, { overdue: [], soon: [] });
    byUser.get(t.assignee_id)[kind].push(t);
  };
  overdue.forEach((t) => add(t, 'overdue'));
  soon.forEach((t) => add(t, 'soon'));

  for (const [uid, { overdue: od, soon: sn }] of byUser) {
    const u = q.get('SELECT * FROM users WHERE id=?', uid);
    if (!u || u.status !== 'active') continue;
    const li = (t, extra) => `<li style="margin:6px 0"><a href="${config.appUrl}/#/tarefa/${t.id}" style="color:#4f46e5;font-weight:600">${escapeHtml(t.title)}</a> — ${extra}</li>`;
    const daysLate = (t) => Math.max(1, Math.ceil((Date.now() - new Date(t.due_date)) / 86400000));
    const body = `
      ${od.length ? `<h3 style="color:#b91c1c;font-size:16px;margin:8px 0">⚠ Tarefas em atraso (${od.length})</h3>
        <ul style="padding-left:18px">${od.map((t) => li(t, `venceu em ${formatDateBR(t.due_date)} · <b>${daysLate(t)} dia(s) de atraso</b>`)).join('')}</ul>` : ''}
      ${sn.length ? `<h3 style="color:#b45309;font-size:16px;margin:8px 0">⏰ Vencendo nas próximas ${config.reminders.dueSoonHours}h (${sn.length})</h3>
        <ul style="padding-left:18px">${sn.map((t) => li(t, `vence em ${formatDateBR(t.due_date)}`)).join('')}</ul>` : ''}
      <p style="color:#6b7280;font-size:13px">Lembrete: a tarefa só é concluída quando o responsável anexa a evidência da conclusão no FinHub.
      Você receberá este aviso ${config.reminders.overdueEveryHours === 24 ? 'diariamente' : `a cada ${config.reminders.overdueEveryHours}h`} enquanto houver tarefas em atraso.</p>`;
    // Notificações in-app sempre; e-mail respeita a preferência do usuário (mas atrasos são enviados sempre)
    const ok = await sendMail({
      to: u.email,
      subject: od.length ? `[FinHub] Você tem ${od.length} tarefa(s) em atraso` : `[FinHub] ${sn.length} tarefa(s) vencendo em breve`,
      html: layout({ title: od.length ? 'Tarefas pendentes de conclusão' : 'Prazos se aproximando', intro: `Olá, ${escapeHtml(u.name.split(' ')[0])}.`, body,
        cta: { label: 'Ver minhas tarefas', url: `${config.appUrl}/#/minhas-tarefas` } }),
    });
    if (ok) {
      for (const t of od) q.run('UPDATE tasks SET last_overdue_notice_at=? WHERE id=?', nowIso, t.id);
      for (const t of sn) q.run('UPDATE tasks SET due_soon_notice_at=? WHERE id=?', nowIso, t.id);
    }
  }
  return { users: byUser.size, overdue: overdue.length, soon: soon.length };
}
