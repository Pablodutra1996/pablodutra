import { state, api, activeUsers, isAdmin } from '../api.js';
import {
  $, $$, esc, avatar, icon, openModal, toast, confirmDialog, promptDialog, fmtDateTime, fmtSize, relTime,
  toLocalInput, fromLocalInput, PRIORITY_LABEL, RECURRENCE_LABEL, SOURCE_LABEL, dueInfo,
} from '../util.js';

const opts = (list, selected, labelFn = (x) => x) =>
  list.map((v) => `<option value="${esc(v)}" ${String(v) === String(selected ?? '') ? 'selected' : ''}>${esc(labelFn(v))}</option>`).join('');

function fieldsHtml(t, { boards }) {
  const m = state.meta;
  return `
    <label class="field">Responsável
      <select class="input" name="assignee_id"><option value="">— Sem responsável —</option>
        ${activeUsers().map((u) => `<option value="${u.id}" ${u.id === t.assignee_id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
      </select></label>
    <label class="field">Prazo<input class="input" type="datetime-local" name="due_date" value="${toLocalInput(t.due_date)}"></label>
    <label class="field">Prioridade<select class="input" name="priority">${opts(m.priorities, t.priority || 'media', (p) => PRIORITY_LABEL[p])}</select></label>
    <label class="field">Categoria<select class="input" name="category"><option value="">— Selecione —</option>${opts(m.categories, t.category)}</select></label>
    <label class="field">Recorrência<select class="input" name="recurrence">${opts(m.recurrences, t.recurrence || 'none', (r) => RECURRENCE_LABEL[r])}</select></label>
    <label class="field">Quadro<select class="input" name="board_id">${boards.map((b) => `<option value="${b.id}" ${b.id === t.board_id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>`;
}

async function loadBoards() {
  const { boards } = await api('/boards');
  state.boards = boards;
  return boards;
}

/** Modal de criação de tarefa */
export async function newTask({ board_id, status = 'todo', onCreated } = {}) {
  const boards = await loadBoards();
  if (!boards.length) return toast('Crie um quadro primeiro.', 'error');
  const t = { board_id: board_id || boards[0].id, assignee_id: state.user.id, priority: 'media', recurrence: 'none' };
  const m = openModal({
    title: 'Nova tarefa',
    body: `<form class="form" id="new-task">
      <label class="field">Título<input class="input" name="title" required autofocus placeholder="Ex.: Conciliação bancária — Itaú"></label>
      <label class="field">Descrição<textarea class="input" name="description" placeholder="O que precisa ser feito, critérios de aceite, onde salvar a evidência…"></textarea></label>
      <div class="form-grid">${fieldsHtml(t, { boards })}</div>
      <div class="error-box hidden"></div>
    </form>`,
    footer: `<button class="btn" data-close>Cancelar</button><button class="btn primary" id="create">Criar tarefa</button>`,
  });
  const form = $('#new-task', m.el);
  const submit = async () => {
    if (!form.reportValidity()) return;
    const d = Object.fromEntries(new FormData(form));
    d.due_date = fromLocalInput(d.due_date);
    d.status = status;
    try {
      const { task } = await api('/tasks', { method: 'POST', body: d });
      m.close();
      toast('Tarefa criada', 'success');
      onCreated?.(task);
    } catch (e) {
      const err = $('.error-box', form);
      err.textContent = e.message;
      err.classList.remove('hidden');
    }
  };
  $('#create', m.el).onclick = submit;
  form.onsubmit = (e) => { e.preventDefault(); submit(); };
}

/** Diálogo de conclusão: exige descrição + arquivo de evidência */
export function completeTask(task, onDone) {
  if (!task.assignee_id) return toast('Defina um responsável antes de concluir.', 'error');
  if (task.assignee_id !== state.user.id) {
    return toast(`Somente o responsável (${task.assignee_name}) pode concluir esta tarefa.`, 'error');
  }
  const files = [];
  const m = openModal({
    title: `Concluir: ${task.title}`,
    body: `
      <div class="rule-box" style="margin-bottom:14px">${icon('shield', 14)} Para concluir, descreva o que foi feito e anexe uma
        <b>evidência clara</b> (comprovante de pagamento, extrato conciliado, print do sistema, relatório, protocolo…).
        A evidência fica registrada para auditoria e não pode ser apagada.</div>
      <form class="form" id="complete-form">
        <label class="field">Descrição da evidência *
          <textarea class="input" name="note" required minlength="10" placeholder="Ex.: Conciliação do Itaú finalizada, 0 pendências. Relatório anexado e salvo em Financeiro/2026/11."></textarea></label>
        <div class="dropzone" id="dz">${icon('clip', 18)}<div style="margin-top:6px"><b>Clique ou arraste</b> os arquivos de evidência aqui</div>
          <div class="small">PDF, imagens, planilhas… até 25 MB cada</div></div>
        <input type="file" id="ev-files" multiple hidden>
        <div id="ev-list"></div>
        <div class="error-box hidden"></div>
      </form>`,
    footer: `<button class="btn" data-close>Cancelar</button><button class="btn success" id="do-complete">${icon('check', 16)} Concluir tarefa</button>`,
  });
  const dz = $('#dz', m.el);
  const input = $('#ev-files', m.el);
  const renderList = () => {
    $('#ev-list', m.el).innerHTML = files.map((f, i) => `<div class="attach evidence"><span class="ico">${esc(f.name.split('.').pop().slice(0, 4).toUpperCase())}</span>
      <div style="flex:1;min-width:0"><div>${esc(f.name)}</div><div class="muted small">${fmtSize(f.size)}</div></div>
      <button type="button" class="btn ghost sm" data-rm="${i}">Remover</button></div>`).join('');
    $$('[data-rm]', m.el).forEach((b) => (b.onclick = () => { files.splice(Number(b.dataset.rm), 1); renderList(); }));
  };
  const addFiles = (list) => { files.push(...list); renderList(); };
  dz.onclick = () => input.click();
  input.onchange = () => { addFiles([...input.files]); input.value = ''; };
  dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('over'); };
  dz.ondragleave = () => dz.classList.remove('over');
  dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove('over'); addFiles([...e.dataTransfer.files]); };

  $('#do-complete', m.el).onclick = async (e) => {
    const form = $('#complete-form', m.el);
    const err = $('.error-box', form);
    err.classList.add('hidden');
    const note = form.note.value.trim();
    if (note.length < 10) { err.textContent = 'Descreva a evidência (mínimo de 10 caracteres).'; return err.classList.remove('hidden'); }
    if (!files.length) { err.textContent = 'Anexe pelo menos um arquivo de evidência.'; return err.classList.remove('hidden'); }
    const fd = new FormData();
    fd.append('note', note);
    files.forEach((f) => fd.append('files', f));
    e.target.disabled = true;
    try {
      const res = await api(`/tasks/${task.id}/complete`, { method: 'POST', form: fd });
      m.close();
      toast(res.next_task_id ? 'Tarefa concluída! A próxima ocorrência já foi criada.' : 'Tarefa concluída com evidência!', 'success');
      onDone?.(res.task);
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
      e.target.disabled = false;
    }
  };
}

const fileIcon = (name) => esc((name.split('.').pop() || '').slice(0, 4).toUpperCase());

/** Modal de detalhes da tarefa (edição com salvamento automático) */
export async function openTask(id, { onClose } = {}) {
  let data;
  try {
    [data] = await Promise.all([api(`/tasks/${id}`), loadBoards()]);
  } catch (e) {
    return toast(e.message, 'error');
  }
  const m = openModal({ title: `Tarefa #${id}`, body: '<div id="task-detail"></div>', wide: true, onClose });

  const render = () => {
    const { task: t, attachments, comments, history } = data;
    const done = t.status === 'done';
    const canComplete = !done && t.assignee_id === state.user.id;
    const canManage = isAdmin() || t.created_by === state.user.id;
    const due = dueInfo(t);
    const evidence = attachments.filter((a) => a.is_evidence === 1);
    const statusOpts = state.meta.statuses.map((s) =>
      `<option value="${s.id}" ${s.id === t.status ? 'selected' : ''} ${s.id === 'done' && !done ? 'disabled' : ''}>${esc(s.label)}${s.id === 'done' && !done ? ' (exige evidência)' : ''}</option>`).join('');
    const attRow = (a) => `<div class="attach ${a.is_evidence === 1 ? 'evidence' : a.is_evidence === 2 ? 'rejected' : ''}">
        <span class="ico">${fileIcon(a.filename)}</span>
        <div style="flex:1;min-width:0"><a href="/api/files/${a.file_id}" target="_blank" rel="noopener">${esc(a.filename)}</a>
          <div class="muted small">${a.is_evidence === 1 ? '✔ Evidência · ' : a.is_evidence === 2 ? '✖ Evidência rejeitada · ' : ''}${esc(a.uploaded_by_name || '')} · ${fmtSize(a.size)} · ${relTime(a.created_at)}</div></div>
        <a class="btn ghost sm" href="/api/files/${a.file_id}?download=1">Baixar</a>
        ${!a.is_evidence ? `<button class="btn ghost sm danger" data-del-att="${a.id}" title="Remover">${icon('trash', 14)}</button>` : ''}
      </div>`;

    $('#task-detail', m.el).innerHTML = `
    <div class="task-detail">
      <div>
        <input class="input title-input" id="f-title" value="${esc(t.title)}" ${done ? 'disabled' : ''}>
        <div class="row wrap" style="margin:6px 8px 14px">
          ${due ? `<span class="tag ${due.cls}">${icon('calendar', 12)} ${esc(due.text)}</span>` : ''}
          <span class="tag p-${t.priority}">${PRIORITY_LABEL[t.priority]}</span>
          ${t.category ? `<span class="tag cat">${esc(t.category)}</span>` : ''}
          ${t.source !== 'manual' ? `<span class="tag src">${esc(SOURCE_LABEL[t.source] || t.source)}</span>` : ''}
          ${t.recurrence !== 'none' ? `<span class="tag">${icon('refresh', 12)} ${RECURRENCE_LABEL[t.recurrence]}</span>` : ''}
        </div>
        ${done ? `<div class="evidence-box"><div class="row"><b style="color:var(--ok)">${icon('check', 16)} Concluída em ${fmtDateTime(t.completed_at)}</b>
            <div class="spacer"></div>${canManage ? `<button class="btn sm" id="reopen">Reabrir</button>` : ''}</div>
            <div style="margin-top:6px;white-space:pre-wrap">${esc(t.completion_note || '')}</div>
            <div style="margin-top:10px">${evidence.map(attRow).join('')}</div></div>`
          : `<div class="rule-box row" style="margin-bottom:12px"><span>${icon('shield', 14)}</span><span style="flex:1">Esta tarefa só pode ser concluída pelo responsável
              ${t.assignee_name ? `(<b>${esc(t.assignee_name)}</b>)` : ''} mediante evidência anexada.</span>
              ${canComplete ? `<button class="btn success sm" id="complete">${icon('check', 14)} Concluir com evidência</button>` : ''}</div>`}
        <div class="section-title">Descrição</div>
        <textarea class="input" id="f-desc" rows="5" placeholder="Adicione detalhes…">${esc(t.description || '')}</textarea>

        <div class="section-title">${icon('clip', 15)} Anexos <span class="badge soft">${attachments.length}</span><div class="spacer"></div>
          <button class="btn sm" id="add-att">${icon('plus', 14)} Anexar</button><input type="file" id="att-input" multiple hidden></div>
        ${attachments.filter((a) => !done || a.is_evidence !== 1).map(attRow).join('') || '<div class="muted small">Nenhum anexo.</div>'}

        <div class="section-title">${icon('comment', 15)} Comentários</div>
        ${comments.map((c) => `<div class="comment">${avatar({ id: c.user_id, name: c.user_name, color: c.user_color }, 30)}
          <div class="bubble"><div class="small"><b>${esc(c.user_name)}</b> <span class="muted">· ${relTime(c.created_at)}</span></div>${esc(c.body)}</div></div>`).join('')}
        <div class="row" style="align-items:flex-end">${avatar(state.user, 30)}
          <textarea class="input" id="comment-text" rows="2" style="min-height:44px" placeholder="Escreva um comentário…"></textarea>
          <button class="btn primary" id="send-comment">Enviar</button></div>
      </div>

      <aside class="side-props">
        <label class="field">Status<select class="input" id="f-status" ${done ? 'disabled' : ''}>${statusOpts}</select></label>
        <div class="form" id="side-fields" style="gap:12px">${fieldsHtml(t, { boards: state.boards })}</div>
        <div class="small muted" style="line-height:1.7;border-top:1px solid var(--line);padding-top:10px">
          Criada por <b>${esc(t.creator_name || 'Importação')}</b><br>em ${fmtDateTime(t.created_at)}<br>
          Origem: ${esc(SOURCE_LABEL[t.source] || t.source)}</div>
        <div class="section-title" style="margin-top:4px">Histórico</div>
        <div class="timeline">${history.map((h) => `<div class="ev"><b>${esc(state.meta.statuses.find((s) => s.id === h.to_status)?.label || h.to_status)}</b>
          <div class="muted small">${esc(h.user_name || 'Sistema')} · ${fmtDateTime(h.created_at)}</div>
          ${h.note ? `<div class="small" style="margin-top:2px">${esc(h.note.slice(0, 140))}</div>` : ''}</div>`).join('')}</div>
        ${canManage ? `<button class="btn danger sm" id="delete">${icon('trash', 14)} Excluir tarefa</button>` : ''}
      </aside>
    </div>`;
    bind();
  };

  const reload = async () => {
    data = await api(`/tasks/${id}`);
    render();
  };
  const patch = async (body) => {
    try {
      const { task } = await api(`/tasks/${id}`, { method: 'PATCH', body });
      data.task = task;
      toast('Alteração salva', 'success');
      render();
    } catch (e) {
      toast(e.message, 'error');
      render();
    }
  };

  function bind() {
    const el = m.el;
    const t = data.task;
    const title = $('#f-title', el);
    title.onchange = () => title.value.trim() && title.value.trim() !== t.title && patch({ title: title.value.trim() });
    const desc = $('#f-desc', el);
    desc.onchange = () => desc.value !== (t.description || '') && patch({ description: desc.value });
    $('#f-status', el).onchange = async (e) => {
      try {
        await api(`/tasks/${id}/move`, { method: 'POST', body: { status: e.target.value } });
        await reload();
      } catch (ex) { toast(ex.message, 'error'); render(); }
    };
    $$('#side-fields select, #side-fields input', el).forEach((inp) => {
      inp.onchange = () => {
        let v = inp.value;
        if (inp.name === 'due_date') v = fromLocalInput(v);
        patch({ [inp.name]: v || null });
      };
    });
    $('#complete', el) && ($('#complete', el).onclick = () => completeTask(t, () => reload()));
    $('#reopen', el) && ($('#reopen', el).onclick = async () => {
      const reason = await promptDialog('Reabrir tarefa', 'Motivo da reabertura (o responsável será avisado por e-mail)', { multiline: true, ok: 'Reabrir' });
      if (!reason) return;
      try { await api(`/tasks/${id}/reopen`, { method: 'POST', body: { reason } }); await reload(); toast('Tarefa reaberta'); } catch (e) { toast(e.message, 'error'); }
    });
    $('#delete', el) && ($('#delete', el).onclick = async () => {
      if (!(await confirmDialog('Excluir esta tarefa definitivamente?', { ok: 'Excluir', danger: true }))) return;
      await api(`/tasks/${id}`, { method: 'DELETE' });
      m.close();
      toast('Tarefa excluída');
    });
    const attInput = $('#att-input', el);
    $('#add-att', el).onclick = () => attInput.click();
    attInput.onchange = async () => {
      const fd = new FormData();
      [...attInput.files].forEach((f) => fd.append('files', f));
      try { await api(`/tasks/${id}/attachments`, { method: 'POST', form: fd }); await reload(); } catch (e) { toast(e.message, 'error'); }
    };
    $$('[data-del-att]', el).forEach((b) => (b.onclick = async () => {
      try { await api(`/tasks/${id}/attachments/${b.dataset.delAtt}`, { method: 'DELETE' }); await reload(); } catch (e) { toast(e.message, 'error'); }
    }));
    const sendComment = async () => {
      const body = $('#comment-text', el).value.trim();
      if (!body) return;
      try { await api(`/tasks/${id}/comments`, { method: 'POST', body: { body } }); await reload(); } catch (e) { toast(e.message, 'error'); }
    };
    $('#send-comment', el).onclick = sendComment;
    $('#comment-text', el).onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendComment(); };
  }

  render();
  return m;
}
