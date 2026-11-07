import { state, api, on, activeUsers } from '../api.js';
import { $, $$, esc, avatar, icon, openModal, toast, dueInfo, PRIORITY_LABEL, STATUS_COLORS, SOURCE_LABEL, fmtDate } from '../util.js';
import { setTitle, setActions } from '../app.js';
import { openTask, newTask, completeTask } from './task-modal.js';

const COLORS = ['#4f46e5', '#0f6cbd', '#059669', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#db2777'];

export async function renderBoards(container) {
  const draw = async () => {
    const { boards } = await api('/boards');
    state.boards = boards;
    container.innerHTML = boards.length ? `<div class="boards-grid">${boards.map((b) => {
      const pct = b.total ? Math.round((b.done / b.total) * 100) : 0;
      return `<div class="card board-tile" data-id="${b.id}" style="border-top-color:${esc(b.color || '#4f46e5')}">
        <h3 style="margin-bottom:4px">${esc(b.name)}</h3>
        <div class="muted small" style="min-height:18px">${esc(b.description || '')}</div>
        <div class="row" style="margin:14px 0 8px"><span class="small"><b>${b.done}</b>/${b.total} concluídas</span><div class="spacer"></div>
          ${b.overdue ? `<span class="tag late">${b.overdue} em atraso</span>` : '<span class="tag ok">Em dia</span>'}</div>
        <div class="progress"><span style="width:${pct}%"></span></div></div>`;
    }).join('')}</div>` : '<div class="empty card">Nenhum quadro ainda. Crie o primeiro!</div>';
    $$('.board-tile', container).forEach((el) => (el.onclick = () => (location.hash = `#/quadro/${el.dataset.id}`)));
  };
  setActions(`<button class="btn primary" id="new-board">${icon('plus', 16)} Novo quadro</button>`);
  $('#new-board').onclick = () => boardDialog(null, draw);
  await draw();
  return on('boards:changed', draw);
}

function boardDialog(board, onSaved) {
  let color = board?.color || COLORS[0];
  const m = openModal({
    title: board ? 'Editar quadro' : 'Novo quadro',
    body: `<form class="form" id="bf">
      <label class="field">Nome<input class="input" name="name" required value="${esc(board?.name || '')}" placeholder="Ex.: Fechamento Mensal"></label>
      <label class="field">Descrição<input class="input" name="description" value="${esc(board?.description || '')}"></label>
      <div class="field">Cor<div class="row">${COLORS.map((c) => `<button type="button" data-c="${c}" style="width:28px;height:28px;border-radius:50%;border:3px solid ${c === color ? '#111' : '#fff'};background:${c};cursor:pointer"></button>`).join('')}</div></div>
    </form>`,
    footer: `${board ? '<button class="btn danger" id="archive">Arquivar</button><div class="spacer"></div>' : ''}<button class="btn" data-close>Cancelar</button><button class="btn primary" id="save">Salvar</button>`,
  });
  $$('[data-c]', m.el).forEach((b) => (b.onclick = () => {
    color = b.dataset.c;
    $$('[data-c]', m.el).forEach((x) => (x.style.borderColor = x.dataset.c === color ? '#111' : '#fff'));
  }));
  $('#save', m.el).onclick = async () => {
    const f = $('#bf', m.el);
    if (!f.reportValidity()) return;
    const body = { ...Object.fromEntries(new FormData(f)), color };
    try {
      await api(board ? `/boards/${board.id}` : '/boards', { method: board ? 'PATCH' : 'POST', body });
      m.close();
      onSaved?.();
    } catch (e) { toast(e.message, 'error'); }
  };
  $('#archive', m.el) && ($('#archive', m.el).onclick = async () => {
    try { await api(`/boards/${board.id}`, { method: 'PATCH', body: { archived: true } }); m.close(); location.hash = '#/quadros'; } catch (e) { toast(e.message, 'error'); }
  });
}

function cardHtml(t) {
  const due = dueInfo(t);
  return `<div class="task-card ${t.status === 'done' ? 'is-done' : ''}" draggable="${t.status !== 'done'}" data-id="${t.id}">
    <div class="row" style="align-items:flex-start"><div class="t-title" style="flex:1">${esc(t.title)}</div>
      ${t.status === 'done' ? `<span class="tag ok" title="Concluída com evidência">${icon('check', 12)}</span>` : ''}</div>
    <div class="meta">
      ${t.category ? `<span class="tag cat">${esc(t.category)}</span>` : ''}
      <span class="tag p-${t.priority}">${PRIORITY_LABEL[t.priority]}</span>
      ${t.source !== 'manual' ? `<span class="tag src" title="${esc(SOURCE_LABEL[t.source])}">${t.source === 'microsoft_todo' ? 'To Do' : esc(SOURCE_LABEL[t.source])}</span>` : ''}
    </div>
    <div class="meta">
      ${due ? `<span class="tag ${due.cls}">${icon('calendar', 11)} ${esc(due.text)}</span>` : ''}
      ${t.attachments_count ? `<span>${icon('clip', 12)} ${t.attachments_count}</span>` : ''}
      ${t.comments_count ? `<span>${icon('comment', 12)} ${t.comments_count}</span>` : ''}
      <div class="spacer"></div>
      ${t.assignee_id ? avatar({ id: t.assignee_id, name: t.assignee_name, color: t.assignee_color }, 24) : '<span class="small">Sem responsável</span>'}
    </div></div>`;
}

export async function renderBoard(container, [boardId]) {
  boardId = Number(boardId);
  let board;
  let tasks = [];
  let view = localStorage.getItem('finhub:view') || 'kanban';
  const filters = { q: '', assignee: '', category: '', priority: '' };

  const loadBoard = async () => {
    const { boards } = await api('/boards');
    state.boards = boards;
    board = boards.find((b) => b.id === boardId);
    if (!board) { toast('Quadro não encontrado', 'error'); location.hash = '#/quadros'; return false; }
    setTitle(board.name);
    return true;
  };
  if (!(await loadBoard())) return;

  setActions(`<button class="btn" id="edit-board">Editar quadro</button><button class="btn primary" id="add">${icon('plus', 16)} Nova tarefa</button>`);
  $('#add').onclick = () => newTask({ board_id: boardId, onCreated: load });
  $('#edit-board').onclick = () => boardDialog(board, async () => { await loadBoard(); });

  container.innerHTML = `
    <div class="toolbar">
      <input class="input" id="flt-q" placeholder="Buscar tarefas…" style="min-width:220px">
      <select class="input" id="flt-assignee"><option value="">Todos os responsáveis</option>
        ${activeUsers().map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select>
      <select class="input" id="flt-category"><option value="">Todas as categorias</option>
        ${state.meta.categories.map((c) => `<option>${esc(c)}</option>`).join('')}</select>
      <select class="input" id="flt-priority"><option value="">Todas as prioridades</option>
        ${state.meta.priorities.map((p) => `<option value="${p}">${PRIORITY_LABEL[p]}</option>`).join('')}</select>
      <div class="spacer"></div>
      <div class="seg"><button data-v="kanban">Kanban</button><button data-v="list">Lista</button></div>
    </div>
    <div id="board-body"></div>`;

  const visible = () => tasks.filter((t) =>
    (!filters.q || `${t.title} ${t.description}`.toLowerCase().includes(filters.q.toLowerCase())) &&
    (!filters.assignee || String(t.assignee_id) === filters.assignee) &&
    (!filters.category || t.category === filters.category) &&
    (!filters.priority || t.priority === filters.priority));

  const draw = () => {
    $$('.seg button', container).forEach((b) => b.classList.toggle('on', b.dataset.v === view));
    const list = visible();
    const body = $('#board-body', container);
    if (view === 'list') {
      const label = (s) => state.meta.statuses.find((x) => x.id === s)?.label;
      body.innerHTML = `<div class="card" style="overflow:auto"><table class="tbl"><thead><tr><th>Tarefa</th><th>Status</th><th>Responsável</th>
        <th>Prazo</th><th>Prioridade</th><th>Categoria</th><th>Evidência</th></tr></thead><tbody>
        ${list.map((t) => { const due = dueInfo(t); return `<tr class="click" data-id="${t.id}"><td><b>${esc(t.title)}</b></td>
          <td><span class="row"><span style="width:8px;height:8px;border-radius:50%;background:${STATUS_COLORS[t.status]}"></span>${esc(label(t.status))}</span></td>
          <td>${t.assignee_id ? `<span class="row">${avatar({ id: t.assignee_id, name: t.assignee_name, color: t.assignee_color }, 22)} ${esc(t.assignee_name)}</span>` : '—'}</td>
          <td>${due ? `<span class="tag ${due.cls}">${esc(t.status === 'done' ? fmtDate(t.due_date) : due.text)}</span>` : '—'}</td>
          <td><span class="tag p-${t.priority}">${PRIORITY_LABEL[t.priority]}</span></td><td>${esc(t.category || '—')}</td>
          <td>${t.evidence_count ? `<span class="tag ok">${icon('check', 11)} ${t.evidence_count}</span>` : '—'}</td></tr>`; }).join('')
          || '<tr><td colspan="7" class="empty">Nenhuma tarefa encontrada</td></tr>'}
        </tbody></table></div>`;
      $$('tr[data-id]', body).forEach((tr) => (tr.onclick = () => openTask(Number(tr.dataset.id))));
      return;
    }
    const recentLimit = new Date(Date.now() - 30 * 86400000).toISOString();
    body.innerHTML = `<div class="kanban">${state.meta.statuses.map((s) => {
      let col = list.filter((t) => t.status === s.id).sort((a, b) => s.id === 'done'
        ? (b.completed_at || '').localeCompare(a.completed_at || '') : a.position - b.position);
      const total = col.length;
      // Coluna "Concluído" mostra só os últimos 30 dias (o histórico completo fica na visão Lista)
      if (s.id === 'done') col = col.filter((t) => t.completed_at >= recentLimit).slice(0, 30);
      return `<div class="column" data-status="${s.id}">
        <div class="column-head"><span class="dot" style="background:${STATUS_COLORS[s.id]}"></span>${esc(s.label)}
          <span class="badge soft">${total}</span>${s.id === 'done' ? `<span class="muted small" title="Somente com evidência">${icon('shield', 13)}</span>` : ''}</div>
        ${s.id === 'done' && total > col.length ? `<div class="muted small" style="padding:0 6px">Mostrando as concluídas nos últimos 30 dias · <a href="#" data-showlist>ver todas</a></div>` : ''}
        ${col.map(cardHtml).join('')}
        ${s.id !== 'done' ? `<button class="add-task" data-add="${s.id}">+ Adicionar tarefa</button>` : ''}
      </div>`;
    }).join('')}</div>`;
    bindKanban(body);
  };

  function bindKanban(body) {
    let dragId = null;
    $$('.task-card', body).forEach((c) => {
      c.onclick = () => openTask(Number(c.dataset.id));
      c.ondragstart = (e) => { dragId = Number(c.dataset.id); c.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; };
      c.ondragend = () => c.classList.remove('dragging');
    });
    $('[data-showlist]', body) && ($('[data-showlist]', body).onclick = (e) => { e.preventDefault(); view = 'list'; draw(); });
    $$('[data-add]', body).forEach((b) => (b.onclick = () => newTask({ board_id: boardId, status: b.dataset.add, onCreated: load })));
    $$('.column', body).forEach((col) => {
      col.ondragover = (e) => { e.preventDefault(); col.classList.add('drop'); };
      col.ondragleave = (e) => !col.contains(e.relatedTarget) && col.classList.remove('drop');
      col.ondrop = async (e) => {
        e.preventDefault();
        col.classList.remove('drop');
        const task = tasks.find((t) => t.id === dragId);
        if (!task) return;
        const status = col.dataset.status;
        if (status === 'done') return completeTask(task, load);
        // posição: depois do card sobre o qual soltou (ou no fim)
        const cards = $$('.task-card', col).filter((c) => Number(c.dataset.id) !== dragId);
        const after = cards.find((c) => e.clientY < c.getBoundingClientRect().top + c.offsetHeight / 2);
        const pos = (id) => tasks.find((t) => t.id === Number(id))?.position ?? 0;
        let position;
        if (!cards.length) position = 1;
        else if (!after) position = pos(cards[cards.length - 1].dataset.id) + 1;
        else {
          const idx = cards.indexOf(after);
          position = idx === 0 ? pos(after.dataset.id) - 1 : (pos(cards[idx - 1].dataset.id) + pos(after.dataset.id)) / 2;
        }
        try {
          await api(`/tasks/${dragId}/move`, { method: 'POST', body: { status, position } });
          await load();
        } catch (ex) { toast(ex.message, 'error'); }
      };
    });
  }

  const load = async () => {
    ({ tasks } = await api(`/tasks?board_id=${boardId}`));
    draw();
  };

  $('#flt-q', container).oninput = (e) => { filters.q = e.target.value; draw(); };
  $('#flt-assignee', container).onchange = (e) => { filters.assignee = e.target.value; draw(); };
  $('#flt-category', container).onchange = (e) => { filters.category = e.target.value; draw(); };
  $('#flt-priority', container).onchange = (e) => { filters.priority = e.target.value; draw(); };
  $$('.seg button', container).forEach((b) => (b.onclick = () => { view = b.dataset.v; localStorage.setItem('finhub:view', view); draw(); }));

  await load();
  const offs = [
    on('task:changed', ({ task }) => {
      if (!task) return;
      const i = tasks.findIndex((t) => t.id === task.id);
      if (task.board_id !== boardId) { if (i >= 0) tasks.splice(i, 1); }
      else if (i >= 0) tasks[i] = task; else tasks.push(task);
      draw();
    }),
    on('task:deleted', ({ id }) => { tasks = tasks.filter((t) => t.id !== id); draw(); }),
  ];
  return () => offs.forEach((off) => off());
}
