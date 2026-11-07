import { api, on } from '../api.js';
import { $$, esc, icon, dueInfo, PRIORITY_LABEL, fmtDateTime } from '../util.js';
import { setActions } from '../app.js';
import { openTask, newTask, completeTask } from './task-modal.js';

export async function renderMyTasks(container) {
  setActions(`<button class="btn primary" id="add">${icon('plus', 16)} Nova tarefa</button>`);
  document.getElementById('add').onclick = () => newTask({ onCreated: draw });

  async function draw() {
    const { tasks } = await api('/tasks?mine=1');
    const nowMs = Date.now();
    const endToday = new Date(); endToday.setHours(23, 59, 59, 999);
    const in7 = nowMs + 7 * 86400000;
    const open = tasks.filter((t) => t.status !== 'done').sort((a, b) => (a.due_date || '9').localeCompare(b.due_date || '9'));
    const groups = [
      { title: 'Em atraso', color: 'var(--bad)', items: open.filter((t) => t.due_date && new Date(t.due_date) < nowMs) },
      { title: 'Hoje', color: 'var(--warn)', items: open.filter((t) => t.due_date && new Date(t.due_date) >= nowMs && new Date(t.due_date) <= endToday) },
      { title: 'Próximos 7 dias', color: 'var(--info)', items: open.filter((t) => t.due_date && new Date(t.due_date) > endToday && new Date(t.due_date) <= in7) },
      { title: 'Mais adiante', color: 'var(--muted)', items: open.filter((t) => t.due_date && new Date(t.due_date) > in7) },
      { title: 'Sem prazo', color: 'var(--muted)', items: open.filter((t) => !t.due_date) },
      { title: 'Concluídas recentemente', color: 'var(--ok)', items: tasks.filter((t) => t.status === 'done').sort((a, b) => b.completed_at.localeCompare(a.completed_at)).slice(0, 10) },
    ];
    const lateCount = groups[0].items.length;
    container.innerHTML = `
      <div class="row wrap" style="gap:14px;margin-bottom:6px">
        <div class="card card-pad" style="flex:1;min-width:180px"><div class="muted small">Abertas</div><div style="font-size:26px;font-weight:700">${open.length}</div></div>
        <div class="card card-pad" style="flex:1;min-width:180px"><div class="muted small">Em atraso</div><div style="font-size:26px;font-weight:700;color:${lateCount ? 'var(--bad)' : 'var(--ok)'}">${lateCount}</div></div>
        <div class="card card-pad" style="flex:1;min-width:180px"><div class="muted small">Vencem hoje</div><div style="font-size:26px;font-weight:700">${groups[1].items.length}</div></div>
      </div>
      ${lateCount ? `<div class="rule-box" style="margin-top:12px;background:var(--bad-50);border-color:#fecaca;color:#991b1b">⚠ Você tem ${lateCount} tarefa(s) em atraso. Você receberá lembretes diários por e-mail até que sejam concluídas com evidência.</div>` : ''}
      ${groups.filter((g) => g.items.length).map((g) => `
        <div class="group-title" style="color:${g.color}">${esc(g.title)} <span class="badge soft">${g.items.length}</span></div>
        ${g.items.map((t) => { const due = dueInfo(t); return `<div class="task-row" data-id="${t.id}">
          <div style="flex:1;min-width:0"><div style="font-weight:600">${esc(t.title)}</div>
            <div class="muted small">${esc(t.board_name)}${t.category ? ` · ${esc(t.category)}` : ''}${t.status === 'done' ? ` · concluída em ${fmtDateTime(t.completed_at)}` : ''}</div></div>
          <span class="tag p-${t.priority}">${PRIORITY_LABEL[t.priority]}</span>
          ${due ? `<span class="tag ${due.cls}">${esc(due.text)}</span>` : ''}
          ${t.status !== 'done' ? `<button class="btn success sm" data-complete="${t.id}">${icon('check', 14)} Concluir</button>` : `<span class="tag ok">${icon('check', 12)} Evidência</span>`}
        </div>`; }).join('')}`).join('') || '<div class="empty card" style="margin-top:16px">Nenhuma tarefa atribuída a você. 🎉</div>'}`;
    $$('.task-row', container).forEach((r) => (r.onclick = (e) => { if (!e.target.closest('[data-complete]')) openTask(Number(r.dataset.id)); }));
    $$('[data-complete]', container).forEach((b) => (b.onclick = () => completeTask(tasks.find((t) => t.id === Number(b.dataset.complete)), draw)));
  }
  await draw();
  const offs = [on('task:changed', draw), on('task:deleted', draw)];
  return () => offs.forEach((o) => o());
}
