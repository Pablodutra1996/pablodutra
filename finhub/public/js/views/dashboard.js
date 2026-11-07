import { state, api, on, activeUsers, isAdmin } from '../api.js';
import { $, $$, esc, avatar, icon, toast, fmtHours, fmtPct, fmtDate, PRIORITY_LABEL, confirmDialog } from '../util.js';
import { setActions } from '../app.js';
import { openTask } from './task-modal.js';

// Paleta categórica validada (slots 1–3) + tinta de texto/grade recessiva
const C = { s1: '#2a78d6', s2: '#eb6834', s3: '#1baf7a', grid: '#eceef3', text: '#52514e' };
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const mLabel = (m) => { const [y, mm] = m.split('-'); return `${MONTHS[Number(mm) - 1]}/${y.slice(2)}`; };
const currentMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

function tone(v, good, mid, invert = false) {
  if (v === null || v === undefined) return '';
  if (invert) return v <= good ? 'good' : v <= mid ? 'mid' : 'bad';
  return v >= good ? 'good' : v >= mid ? 'mid' : 'bad';
}

export async function renderDashboard(container, _p, query) {
  let month = query.mes || currentMonth();
  let userId = query.pessoa || '';
  const charts = [];

  setActions(isAdmin() ? `<button class="btn" id="send-report" title="Envia agora o resumo do mês selecionado por e-mail para todos">${icon('mail', 16)} Enviar resumo por e-mail</button>` : '');

  container.innerHTML = `
    <div class="toolbar">
      <label class="row small muted">Mês <input type="month" class="input" id="f-month" value="${month}" max="${currentMonth()}"></label>
      <label class="row small muted">Visão
        <select class="input" id="f-user"><option value="">Equipe toda</option>
          ${activeUsers().map((u) => `<option value="${u.id}" ${String(u.id) === userId ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
      <div class="spacer"></div><span class="muted small" id="gen-at"></span>
    </div>
    <div id="dash"></div>`;

  async function load() {
    charts.splice(0).forEach((c) => c.destroy());
    let d;
    try {
      d = await api(`/dashboard?month=${month}${userId ? `&user_id=${userId}` : ''}`);
    } catch (e) { return toast(e.message, 'error'); }
    const s = d.summary;
    $('#gen-at', container).textContent = `Atualizado em ${new Date(d.generated_at).toLocaleString('pt-BR')}`;
    const kpi = (lbl, val, sub, cls = '', help = '') =>
      `<div class="card kpi" title="${esc(help)}"><div class="lbl">${lbl}</div><div class="val ${cls}">${val}</div><div class="sub">${sub}</div></div>`;

    $('#dash', container).innerHTML = `
      <div class="kpis">
        ${kpi('Taxa de conclusão', fmtPct(s.completion_rate), `${s.due_completed} de ${s.due_in_period} com prazo no mês`, tone(s.completion_rate, 90, 70), '% das tarefas com vencimento no mês que estão concluídas')}
        ${kpi('Entregas no prazo', fmtPct(s.on_time_rate), `${s.on_time} no prazo · ${s.late} com atraso`, tone(s.on_time_rate, 90, 70), '% das concluídas no mês entregues até o vencimento')}
        ${kpi('Concluídas no mês', s.completed, `${s.created} criadas no mês`)}
        ${kpi('Em atraso', s.overdue_open, `${s.open_now} abertas no total`, s.overdue_open ? 'bad' : 'good', 'Tarefas abertas com prazo vencido no fechamento do período')}
        ${kpi('Tempo médio de conclusão', fmtHours(s.avg_lead_time_h), 'da criação à conclusão (lead time)')}
        ${kpi('Tempo médio de execução', fmtHours(s.avg_cycle_time_h), 'do início à conclusão (cycle time)')}
        ${kpi('Atraso médio', fmtHours(s.avg_delay_h), 'nas entregas fora do prazo', s.avg_delay_h ? 'mid' : '')}
        ${kpi('Reaberturas', s.reopened, 'evidências rejeitadas no mês', s.reopened ? 'mid' : '')}
      </div>

      <div class="charts" style="margin-top:14px">
        <div class="card card-pad"><h3>Tendência · taxa de conclusão e entregas no prazo (últimos 6 meses)</h3><div class="chart-box"><canvas id="ch-trend"></canvas></div></div>
        <div class="card card-pad"><h3>Tarefas concluídas por mês</h3><div class="chart-box"><canvas id="ch-throughput"></canvas></div></div>
      </div>
      <div class="charts" style="margin-top:14px">
        <div class="card card-pad"><h3>Por categoria · concluídas × em atraso</h3><div class="chart-box"><canvas id="ch-cat"></canvas></div></div>
        <div class="card card-pad"><h3>Tempo médio em cada etapa</h3><div class="chart-box"><canvas id="ch-status"></canvas></div>
          <p class="muted small" style="margin:8px 0 0">Ajuda a identificar gargalos: muito tempo em "Aguardando Terceiros" indica dependência externa.</p></div>
      </div>

      ${!userId ? `<div class="card" style="margin-top:14px;overflow:auto"><div class="card-pad" style="padding-bottom:0"><h3>Desempenho por responsável</h3></div>
        <table class="tbl"><thead><tr><th>Pessoa</th><th>Concluídas</th><th>Taxa de conclusão</th><th>No prazo</th><th>Lead time</th><th>Cycle time</th><th>Abertas</th><th>Em atraso</th><th>Reaberturas</th></tr></thead>
        <tbody>${d.by_assignee.map((a) => `<tr class="click" data-user="${a.user_id}"><td><span class="row">${avatar({ ...a, id: a.user_id }, 26)} ${esc(a.name)}</span></td>
          <td>${a.completed}</td><td><span class="tag ${tone(a.completion_rate, 90, 70) === 'good' ? 'ok' : tone(a.completion_rate, 90, 70) === 'bad' ? 'late' : tone(a.completion_rate, 90, 70) ? 'soon' : ''}">${fmtPct(a.completion_rate)}</span></td>
          <td>${fmtPct(a.on_time_rate)}</td><td>${fmtHours(a.avg_lead_time_h)}</td><td>${fmtHours(a.avg_cycle_time_h)}</td><td>${a.open_now}</td>
          <td>${a.overdue_open ? `<span class="tag late">${a.overdue_open}</span>` : '0'}</td><td>${a.reopened}</td></tr>`).join('')}</tbody></table></div>` : ''}

      <div class="charts" style="margin-top:14px">
        <div class="card" style="overflow:auto"><div class="card-pad" style="padding-bottom:0"><h3>Tarefas em atraso</h3></div>
          ${d.overdue_tasks.length ? `<table class="tbl"><thead><tr><th>Tarefa</th><th>Responsável</th><th>Venceu em</th><th>Prioridade</th></tr></thead><tbody>
          ${d.overdue_tasks.map((t) => `<tr class="click" data-task="${t.id}"><td><b>${esc(t.title)}</b><div class="muted small">${esc(t.category || '')}</div></td>
            <td>${esc(t.assignee_name || '—')}</td><td><span class="tag late">${fmtDate(t.due_date)}</span></td><td><span class="tag p-${t.priority}">${PRIORITY_LABEL[t.priority]}</span></td></tr>`).join('')}
          </tbody></table>` : '<div class="empty">✔ Nenhuma tarefa em atraso</div>'}</div>
        <div class="card" style="overflow:auto"><div class="card-pad" style="padding-bottom:0"><h3>Tabela por categoria</h3></div>
          <table class="tbl"><thead><tr><th>Categoria</th><th>Criadas</th><th>Concluídas</th><th>Conclusão</th><th>Em atraso</th></tr></thead><tbody>
          ${d.by_category.map((c) => `<tr><td>${esc(c.category)}</td><td>${c.created}</td><td>${c.completed}</td><td>${fmtPct(c.completion_rate)}</td><td>${c.overdue_open}</td></tr>`).join('')
            || '<tr><td colspan="5" class="empty">Sem dados no período</td></tr>'}</tbody></table></div>
      </div>`;

    $$('[data-task]', container).forEach((r) => (r.onclick = () => openTask(Number(r.dataset.task))));
    $$('[data-user]', container).forEach((r) => (r.onclick = () => { userId = r.dataset.user; $('#f-user', container).value = userId; load(); }));
    drawCharts(d);
  }

  function drawCharts(d) {
    if (!window.Chart) return setTimeout(() => drawCharts(d), 200);
    const Chart = window.Chart;
    Chart.defaults.font.family = 'Inter, Segoe UI, sans-serif';
    Chart.defaults.color = C.text;
    const grid = { color: C.grid, drawTicks: false };
    const base = {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8 } } },
    };
    const pctTip = { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y === null ? '—' : `${String(c.parsed.y).replace('.', ',')}%`}` } };

    charts.push(new Chart($('#ch-trend'), {
      type: 'line',
      data: {
        labels: d.trend.map((t) => mLabel(t.month)),
        datasets: [
          { label: 'Taxa de conclusão', data: d.trend.map((t) => t.completion_rate), borderColor: C.s1, backgroundColor: C.s1, borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, spanGaps: true, tension: 0.25 },
          { label: 'Entregas no prazo', data: d.trend.map((t) => t.on_time_rate), borderColor: C.s2, backgroundColor: C.s2, borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, spanGaps: true, tension: 0.25 },
        ],
      },
      options: { ...base, plugins: { ...base.plugins, tooltip: pctTip },
        scales: { y: { min: 0, max: 100, grid, border: { display: false }, ticks: { callback: (v) => `${v}%`, padding: 6 } }, x: { grid: { display: false } } } },
    }));

    charts.push(new Chart($('#ch-throughput'), {
      type: 'bar',
      data: { labels: d.trend.map((t) => mLabel(t.month)), datasets: [{ label: 'Concluídas', data: d.trend.map((t) => t.completed), backgroundColor: C.s1, borderRadius: 4, maxBarThickness: 36 }] },
      options: { ...base, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, grid, border: { display: false }, ticks: { precision: 0, padding: 6 } }, x: { grid: { display: false } } } },
    }));

    const cats = d.by_category.length ? d.by_category : [{ category: 'Sem dados', completed: 0, overdue_open: 0 }];
    charts.push(new Chart($('#ch-cat'), {
      type: 'bar',
      data: {
        labels: cats.map((c) => c.category),
        datasets: [
          { label: 'Concluídas no mês', data: cats.map((c) => c.completed), backgroundColor: C.s1, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 14 },
          { label: 'Em atraso', data: cats.map((c) => c.overdue_open), backgroundColor: C.s2, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 14 },
        ],
      },
      options: { ...base, indexAxis: 'y', interaction: { mode: 'index', intersect: false, axis: 'y' },
        scales: { x: { beginAtZero: true, grid, border: { display: false }, ticks: { precision: 0 } }, y: { grid: { display: false } } } },
    }));

    const st = state.meta.statuses.filter((x) => x.id !== 'done');
    charts.push(new Chart($('#ch-status'), {
      type: 'bar',
      data: { labels: st.map((x) => x.label), datasets: [{ label: 'Tempo médio', data: st.map((x) => d.summary.time_in_status_h[x.id] ?? 0), backgroundColor: C.s1, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 22 }] },
      options: { ...base, indexAxis: 'y', interaction: { mode: 'nearest', intersect: false, axis: 'y' },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `Tempo médio: ${fmtHours(c.parsed.x)}` } } },
        scales: { x: { beginAtZero: true, grid, border: { display: false }, ticks: { callback: (v) => fmtHours(v) } }, y: { grid: { display: false } } } },
    }));
  }

  const sync = () => history.replaceState(null, '', `#/dashboard?mes=${month}${userId ? `&pessoa=${userId}` : ''}`);
  $('#f-month', container).onchange = (e) => { month = e.target.value || currentMonth(); sync(); load(); };
  $('#f-user', container).onchange = (e) => { userId = e.target.value; sync(); load(); };
  $('#send-report') && ($('#send-report').onclick = async () => {
    if (!(await confirmDialog(`Enviar agora o resumo de indicadores de ${month} por e-mail para toda a equipe?`, { ok: 'Enviar' }))) return;
    try { const r = await api('/dashboard/send-report', { method: 'POST', body: { month } }); toast(`Resumo enviado para ${r.sent} de ${r.total} pessoa(s).`, 'success'); } catch (e) { toast(e.message, 'error'); }
  });

  await load();
  let t;
  const off = on('task:changed', () => { clearTimeout(t); t = setTimeout(load, 1500); });
  return () => { off(); clearTimeout(t); charts.forEach((c) => c.destroy()); };
}
