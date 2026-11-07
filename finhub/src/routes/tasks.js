import { Router } from 'express';
import { q, now, tx } from '../db.js';
import { config, STATUS_IDS, PRIORITIES, RECURRENCES, CATEGORIES, STATUSES } from '../config.js';
import { fail, toIso, escapeHtml, formatDateBR } from '../util.js';
import { upload, saveFile, notify } from '../services.js';
import { emitAll } from '../realtime.js';
import { layout } from '../mailer.js';

const r = Router();
const statusLabel = (s) => STATUSES.find((x) => x.id === s)?.label || s;

const TASK_SELECT = `
  SELECT t.*, u.name assignee_name, u.color assignee_color, c.name creator_name, b.name board_name,
    (SELECT COUNT(*) FROM task_attachments a WHERE a.task_id=t.id) attachments_count,
    (SELECT COUNT(*) FROM task_attachments a WHERE a.task_id=t.id AND a.is_evidence=1) evidence_count,
    (SELECT COUNT(*) FROM task_comments m WHERE m.task_id=t.id) comments_count
  FROM tasks t
  LEFT JOIN users u ON u.id=t.assignee_id
  LEFT JOIN users c ON c.id=t.created_by
  LEFT JOIN boards b ON b.id=t.board_id`;

export const loadTask = (id) => q.get(`${TASK_SELECT} WHERE t.id=?`, id);

async function getTaskOr404(id) {
  const t = await loadTask(id);
  if (!t) fail(404, 'Tarefa não encontrada.');
  return t;
}

export async function addHistory(taskId, from, to, userId, note = null) {
  await q.run('INSERT INTO task_history (task_id, from_status, to_status, user_id, note, created_at) VALUES (?,?,?,?,?,?)',
    taskId, from, to, userId, note, now());
}

const broadcast = async (taskId) => emitAll('task:changed', { id: taskId, task: await loadTask(taskId) });

async function validateFields(body, partial) {
  const out = {};
  if (!partial || body.title !== undefined) {
    if (!String(body.title || '').trim()) fail(400, 'Informe o título da tarefa.');
    out.title = String(body.title).trim().slice(0, 300);
  }
  if (body.description !== undefined) out.description = String(body.description || '');
  if (body.priority !== undefined) {
    if (!PRIORITIES.includes(body.priority)) fail(400, 'Prioridade inválida.');
    out.priority = body.priority;
  }
  if (body.category !== undefined) out.category = body.category || null;
  if (body.recurrence !== undefined) {
    if (!RECURRENCES.includes(body.recurrence)) fail(400, 'Recorrência inválida.');
    out.recurrence = body.recurrence;
  }
  if (body.due_date !== undefined) out.due_date = toIso(body.due_date);
  if (body.assignee_id !== undefined) {
    const id = body.assignee_id ? Number(body.assignee_id) : null;
    if (id && !await q.get(`SELECT id FROM users WHERE id=? AND status='active'`, id)) fail(400, 'Responsável inválido.');
    out.assignee_id = id;
  }
  if (body.board_id !== undefined) {
    if (!await q.get('SELECT id FROM boards WHERE id=?', body.board_id)) fail(400, 'Quadro inválido.');
    out.board_id = Number(body.board_id);
  }
  return out;
}

async function notifyAssigned(task, byUser) {
  if (!task.assignee_id || task.assignee_id === byUser.id) return;
  await notify(task.assignee_id, {
    title: `Nova tarefa atribuída: ${task.title}`,
    body: `${byUser.name} atribuiu esta tarefa a você${task.due_date ? `. Prazo: ${formatDateBR(task.due_date)}` : ''}.`,
    link: `#/tarefa/${task.id}`,
    email: true,
  });
}

// ---------- Listagem ----------
r.get('/meta', async (req, res) => {
  res.json({ statuses: STATUSES, priorities: PRIORITIES, categories: CATEGORIES, recurrences: RECURRENCES });
});

r.get('/', async (req, res) => {
  const where = [];
  const params = [];
  const { board_id, assignee_id, status, mine, q: search, category } = req.query;
  if (board_id) { where.push('t.board_id=?'); params.push(Number(board_id)); }
  if (mine === '1') { where.push('t.assignee_id=?'); params.push(req.user.id); }
  else if (assignee_id) { where.push('t.assignee_id=?'); params.push(Number(assignee_id)); }
  if (status) { where.push('t.status=?'); params.push(status); }
  if (category) { where.push('t.category=?'); params.push(category); }
  if (search) { where.push('(LOWER(t.title) LIKE LOWER(?) OR LOWER(t.description) LIKE LOWER(?))'); params.push(`%${search}%`, `%${search}%`); }
  where.push('b.archived=0');
  const tasks = await q.all(`${TASK_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.position, t.id`, ...params);
  res.json({ tasks });
});

r.get('/:id', async (req, res) => {
  const task = await getTaskOr404(req.params.id);
  const attachments = await q.all(`SELECT a.id, a.is_evidence, a.created_at, f.id file_id, f.filename, f.mime, f.size, u.name uploaded_by_name
    FROM task_attachments a JOIN files f ON f.id=a.file_id LEFT JOIN users u ON u.id=f.uploaded_by
    WHERE a.task_id=? ORDER BY a.created_at DESC`, task.id);
  const comments = await q.all(`SELECT c.*, u.name user_name, u.color user_color FROM task_comments c LEFT JOIN users u ON u.id=c.user_id
    WHERE c.task_id=? ORDER BY c.created_at`, task.id);
  const history = await q.all(`SELECT h.*, u.name user_name FROM task_history h LEFT JOIN users u ON u.id=h.user_id
    WHERE h.task_id=? ORDER BY h.created_at`, task.id);
  res.json({ task, attachments, comments, history });
});

// ---------- Criação / edição ----------
r.post('/', async (req, res) => {
  const body = req.body || {};
  const f = await validateFields({ priority: 'media', recurrence: 'none', ...body }, false);
  if (!f.board_id) fail(400, 'Informe o quadro.');
  const status = STATUS_IDS.includes(body.status) && body.status !== 'done' ? body.status : 'todo';
  const pos = (await q.get('SELECT COALESCE(MAX(position),0)+1 p FROM tasks WHERE board_id=? AND status=?', f.board_id, status)).p;
  const id = await tx(async () => {
    const info = await q.run(`INSERT INTO tasks (board_id, title, description, status, priority, category, assignee_id, created_by, due_date,
        recurrence, position, started_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      f.board_id, f.title, f.description || '', status, f.priority, f.category || null, f.assignee_id ?? null, req.user.id,
      f.due_date ?? null, f.recurrence, pos, status === 'doing' ? now() : null, now(), now());
    const id = Number(info.lastInsertRowid);
    await addHistory(id, null, status, req.user.id, 'Tarefa criada');
    return id;
  });
  const task = await loadTask(id);
  await notifyAssigned(task, req.user);
  await broadcast(id);
  res.json({ task });
});

r.patch('/:id', async (req, res) => {
  const task = await getTaskOr404(req.params.id);
  const f = await validateFields(req.body || {}, true);
  if (task.status === 'done' && Object.keys(f).some((k) => ['title', 'assignee_id', 'due_date'].includes(k))) {
    fail(400, 'Tarefa concluída não pode ter título, responsável ou prazo alterados. Reabra a tarefa antes.');
  }
  const keys = Object.keys(f);
  if (keys.length) {
    const resetNotices = 'due_date' in f ? ', last_overdue_notice_at=NULL, due_soon_notice_at=NULL' : '';
    await q.run(`UPDATE tasks SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=?${resetNotices} WHERE id=?`, ...keys.map((k) => f[k]), now(), task.id);
  }
  const updated = await loadTask(task.id);
  if ('assignee_id' in f && f.assignee_id !== task.assignee_id) await notifyAssigned(updated, req.user);
  await broadcast(task.id);
  res.json({ task: updated });
});

// Mover no kanban (qualquer status exceto "Concluído", que exige evidência)
r.post('/:id/move', async (req, res) => {
  const task = await getTaskOr404(req.params.id);
  const { status, position } = req.body || {};
  if (!STATUS_IDS.includes(status)) fail(400, 'Status inválido.');
  if (status === 'done' && task.status !== 'done') fail(409, 'Para concluir, o responsável precisa anexar a evidência da conclusão.');
  if (task.status === 'done' && status !== 'done') fail(409, 'Para tirar a tarefa de "Concluído", use a opção "Reabrir".');
  await tx(async () => {
    if (status !== task.status) {
      const startedAt = task.started_at || (status === 'doing' ? now() : null);
      await q.run('UPDATE tasks SET status=?, started_at=?, updated_at=? WHERE id=?', status, startedAt, now(), task.id);
      await addHistory(task.id, task.status, status, req.user.id);
    }
    if (position !== undefined) await q.run('UPDATE tasks SET position=? WHERE id=?', Number(position), task.id);
  });
  await broadcast(task.id);
  res.json({ task: await loadTask(task.id) });
});

// ---------- Conclusão com evidência ----------
r.post('/:id/complete', upload.array('files', 10), async (req, res) => {
  const task = await getTaskOr404(req.params.id);
  if (task.status === 'done') fail(409, 'Esta tarefa já está concluída.');
  if (!task.assignee_id) fail(409, 'Defina um responsável antes de concluir a tarefa.');
  if (task.assignee_id !== req.user.id) fail(403, `Somente o responsável (${task.assignee_name}) pode concluir esta tarefa.`);
  const note = String(req.body?.note || '').trim();
  if (note.length < 10) fail(400, 'Descreva a evidência da conclusão (mínimo de 10 caracteres): o que foi feito e onde comprovar.');

  for (const file of req.files || []) {
    const fileId = await saveFile(file, { prefix: `tasks/${task.id}/evidencias`, userId: req.user.id });
    await q.run('INSERT INTO task_attachments (task_id, file_id, is_evidence, created_at) VALUES (?,?,1,?)', task.id, fileId, now());
  }
  const evidence = (await q.get('SELECT COUNT(*) c FROM task_attachments WHERE task_id=? AND is_evidence=1', task.id)).c;
  if (evidence === 0) fail(400, 'Anexe pelo menos um arquivo de evidência (comprovante, print, relatório, extrato...).');

  await tx(async () => {
    await q.run(`UPDATE tasks SET status='done', completed_at=?, completion_note=?, updated_at=? WHERE id=?`, now(), note, now(), task.id);
    await addHistory(task.id, task.status, 'done', req.user.id, note);
  });

  // Tarefas recorrentes (ex.: fechamento mensal) geram a próxima ocorrência
  let next = null;
  if (task.recurrence !== 'none') {
    const base = new Date(task.due_date || now());
    if (task.recurrence === 'daily') base.setUTCDate(base.getUTCDate() + 1);
    if (task.recurrence === 'weekly') base.setUTCDate(base.getUTCDate() + 7);
    if (task.recurrence === 'monthly') base.setUTCMonth(base.getUTCMonth() + 1);
    const info = await q.run(`INSERT INTO tasks (board_id, title, description, status, priority, category, assignee_id, created_by, due_date,
        recurrence, position, created_at, updated_at) VALUES (?,?,?,'todo',?,?,?,?,?,?,?,?,?)`,
      task.board_id, task.title, task.description, task.priority, task.category, task.assignee_id, task.created_by,
      base.toISOString(), task.recurrence,
      (await q.get(`SELECT COALESCE(MAX(position),0)+1 p FROM tasks WHERE board_id=? AND status='todo'`, task.board_id)).p, now(), now());
    next = Number(info.lastInsertRowid);
    await addHistory(next, null, 'todo', null, `Recorrência gerada a partir da tarefa #${task.id}`);
    await broadcast(next);
  }

  if (task.created_by && task.created_by !== req.user.id) {
    await notify(task.created_by, {
      title: `Tarefa concluída: ${task.title}`,
      body: `${req.user.name} concluiu a tarefa e anexou evidência: "${note.slice(0, 200)}"`,
      link: `#/tarefa/${task.id}`,
      email: true,
    });
  }
  await broadcast(task.id);
  res.json({ task: await loadTask(task.id), next_task_id: next });
});

r.post('/:id/reopen', async (req, res) => {
  const task = await getTaskOr404(req.params.id);
  if (task.status !== 'done') fail(409, 'A tarefa não está concluída.');
  if (req.user.role !== 'admin' && task.created_by !== req.user.id) fail(403, 'Somente quem criou a tarefa ou um administrador pode reabri-la.');
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 5) fail(400, 'Informe o motivo da reabertura (ex.: evidência insuficiente).');
  await tx(async () => {
    await q.run(`UPDATE tasks SET status='doing', completed_at=NULL, completion_note=NULL, last_overdue_notice_at=NULL, updated_at=? WHERE id=?`, now(), task.id);
    await q.run('UPDATE task_attachments SET is_evidence=2 WHERE task_id=? AND is_evidence=1', task.id);
    await addHistory(task.id, 'done', 'doing', req.user.id, `Reaberta: ${reason}`);
  });
  await notify(task.assignee_id, {
    title: `Tarefa reaberta: ${task.title}`,
    body: `${req.user.name} reabriu a tarefa. Motivo: ${reason}`,
    link: `#/tarefa/${task.id}`,
    email: true,
    emailHtml: layout({
      title: `Tarefa reaberta: ${task.title}`,
      intro: `${escapeHtml(req.user.name)} reabriu a tarefa e a evidência anterior foi marcada como rejeitada.<br><b>Motivo:</b> ${escapeHtml(reason)}`,
      cta: { label: 'Ver tarefa', url: `${config.appUrl}/#/tarefa/${task.id}` },
    }),
  });
  await broadcast(task.id);
  res.json({ task: await loadTask(task.id) });
});

r.delete('/:id', async (req, res) => {
  const task = await getTaskOr404(req.params.id);
  if (req.user.role !== 'admin' && task.created_by !== req.user.id) fail(403, 'Somente quem criou a tarefa ou um administrador pode excluí-la.');
  await q.run('DELETE FROM tasks WHERE id=?', task.id);
  emitAll('task:deleted', { id: task.id });
  res.json({ ok: true });
});

// ---------- Anexos e comentários ----------
r.post('/:id/attachments', upload.array('files', 10), async (req, res) => {
  const task = await getTaskOr404(req.params.id);
  if (!req.files?.length) fail(400, 'Nenhum arquivo enviado.');
  for (const file of req.files) {
    const fileId = await saveFile(file, { prefix: `tasks/${task.id}`, userId: req.user.id });
    await q.run('INSERT INTO task_attachments (task_id, file_id, is_evidence, created_at) VALUES (?,?,0,?)', task.id, fileId, now());
  }
  await broadcast(task.id);
  res.json({ ok: true });
});

r.delete('/:id/attachments/:attId', async (req, res) => {
  const att = await q.get(`SELECT a.*, f.uploaded_by FROM task_attachments a JOIN files f ON f.id=a.file_id WHERE a.id=? AND a.task_id=?`,
    req.params.attId, req.params.id);
  if (!att) fail(404, 'Anexo não encontrado.');
  if (att.is_evidence) fail(409, 'Evidências não podem ser removidas (trilha de auditoria).');
  if (att.uploaded_by !== req.user.id && req.user.role !== 'admin') fail(403, 'Você só pode remover anexos que enviou.');
  await q.run('DELETE FROM task_attachments WHERE id=?', att.id);
  await broadcast(Number(req.params.id));
  res.json({ ok: true });
});

r.post('/:id/comments', async (req, res) => {
  const task = await getTaskOr404(req.params.id);
  const body = String(req.body?.body || '').trim();
  if (!body) fail(400, 'Comentário vazio.');
  await q.run('INSERT INTO task_comments (task_id, user_id, body, created_at) VALUES (?,?,?,?)', task.id, req.user.id, body, now());
  const targets = new Set([task.assignee_id, task.created_by].filter((id) => id && id !== req.user.id));
  for (const uid of targets) {
    await notify(uid, { title: `Novo comentário em: ${task.title}`, body: `${req.user.name}: ${body.slice(0, 200)}`, link: `#/tarefa/${task.id}` });
  }
  await broadcast(task.id);
  res.json({ ok: true });
});

export { statusLabel };
export default r;
