// Uso: inicie o servidor com um DATA_DIR vazio e rode: BASE=http://localhost:3000 node scripts/teste-api.mjs
const B = `${process.env.BASE || 'http://localhost:3000'}/api`;
const jar = {};
async function call(who, path, { method = 'GET', body, form } = {}) {
  const headers = {}; if (jar[who]) headers.cookie = jar[who];
  let payload;
  if (form) payload = form; else if (body) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(B + path, { method, headers, body: payload });
  const sc = r.headers.get('set-cookie'); if (sc) jar[who] = sc.split(';')[0];
  const j = await r.json().catch(() => ({}));
  return { s: r.status, j };
}
const ok = (c, msg) => { console.log(c ? '✔' : '✘', msg); if (!c) process.exitCode = 1; };

let r = await call('admin', '/auth/setup', { method: 'POST', body: { name: 'Pablo Dutra', email: 'pablo@ex.com', password: 'Senha1234' } });
ok(r.s === 200 && r.j.user.role === 'admin', 'setup admin');
r = await call('admin', '/users/invite', { method: 'POST', body: { email: 'ana@ex.com' } });
ok(r.s === 200 && r.j.sent, 'convite enviado (outbox)');
const token = r.j.link.split('/convite/')[1];
r = await call('ana', `/auth/invite/${token}`); ok(r.j.email === 'ana@ex.com', 'convite válido');
r = await call('ana', '/auth/accept-invite', { method: 'POST', body: { token, name: 'Ana Souza', password: 'curta' } });
ok(r.s === 400, 'senha fraca rejeitada');
r = await call('ana', '/auth/accept-invite', { method: 'POST', body: { token, name: 'Ana Souza', password: 'Senha1234' } });
ok(r.s === 200, 'convite aceito, ana logada'); const anaId = r.j.user.id;
r = await call('ana', '/auth/accept-invite', { method: 'POST', body: { token, name: 'X', password: 'Senha1234' } });
ok(r.s === 404, 'convite não reutilizável');

const { j: { boards } } = await call('admin', '/boards');
r = await call('admin', '/tasks', { method: 'POST', body: { board_id: boards[0].id, title: 'Conciliação Itaú', assignee_id: anaId, due_date: new Date(Date.now() - 2 * 86400000).toISOString(), category: 'Conciliação Bancária', recurrence: 'monthly' } });
ok(r.s === 200, 'tarefa criada (atrasada, recorrente)'); const tid = r.j.task.id;
r = await call('ana', `/tasks/${tid}/move`, { method: 'POST', body: { status: 'doing' } }); ok(r.s === 200, 'mover para Em Andamento');
r = await call('ana', `/tasks/${tid}/move`, { method: 'POST', body: { status: 'done' } }); ok(r.s === 409, 'arrastar p/ Concluído bloqueado');
let fd = new FormData(); fd.append('note', 'Conciliação feita, sem pendências.'); fd.append('files', new Blob(['extrato'], { type: 'text/plain' }), 'extrato.txt');
r = await call('admin', `/tasks/${tid}/complete`, { method: 'POST', form: fd }); ok(r.s === 403, `não-responsável não conclui: ${r.j.error}`);
fd = new FormData(); fd.append('note', 'Conciliação feita, sem pendências.');
r = await call('ana', `/tasks/${tid}/complete`, { method: 'POST', form: fd }); ok(r.s === 400, `sem arquivo não conclui: ${r.j.error}`);
fd = new FormData(); fd.append('note', 'curta'); fd.append('files', new Blob(['x']), 'a.txt');
r = await call('ana', `/tasks/${tid}/complete`, { method: 'POST', form: fd }); ok(r.s === 400, 'descrição curta rejeitada');

r = await call('admin', '/dashboard/run-reminders', { method: 'POST' }); ok(r.j.overdue >= 1, `lembrete de atraso: ${JSON.stringify(r.j)}`);
r = await call('admin', '/dashboard/run-reminders', { method: 'POST' }); ok(r.j.overdue === 0, 'não repete antes de 24h');

fd = new FormData(); fd.append('note', 'Conciliação Itaú finalizada; extrato conciliado em anexo.'); fd.append('files', new Blob(['%PDF extrato'], { type: 'application/pdf' }), 'extrato-itaú.pdf');
r = await call('ana', `/tasks/${tid}/complete`, { method: 'POST', form: fd }); ok(r.s === 200 && r.j.task.status === 'done' && r.j.next_task_id, 'concluída com evidência + próxima recorrência criada');
r = await call('ana', `/tasks/${tid}`); ok(r.j.attachments[0].filename === 'extrato-itaú.pdf' && r.j.attachments[0].is_evidence === 1, 'evidência registrada (acentos ok)');
const fileId = r.j.attachments[0].file_id;
const dl = await fetch(`${B}/files/${fileId}`, { headers: { cookie: jar.ana } }); ok(dl.status === 200 && (await dl.text()) === '%PDF extrato', 'download do arquivo');
r = await call('ana', `/tasks/${tid}/attachments/${(await call('ana', `/tasks/${tid}`)).j.attachments[0].id}`, { method: 'DELETE' }); ok(r.s === 409, 'evidência não pode ser apagada');
r = await call('ana', `/tasks/${tid}/reopen`, { method: 'POST', body: { reason: 'teste' } }); ok(r.s === 403, 'membro não-criador não reabre');
r = await call('admin', `/tasks/${tid}/reopen`, { method: 'POST', body: { reason: 'Evidência sem o saldo final' } }); ok(r.s === 200 && r.j.task.status === 'doing', 'admin reabre');
r = await call('ana', `/tasks/${tid}`); ok(r.j.attachments[0].is_evidence === 2, 'evidência anterior marcada como rejeitada');
fd = new FormData(); fd.append('note', 'Agora com saldo final conferido.');
r = await call('ana', `/tasks/${tid}/complete`, { method: 'POST', form: fd }); ok(r.s === 400, 'evidência rejeitada não conta para nova conclusão');

const csv = 'Título;Descrição;Vencimento;Responsável;Prioridade;Status\nPagar fornecedor XPTO;Boleto;15/11/2026;ana@ex.com;Alta;\nTarefa antiga;;01/10/2026;;;Concluído\n';
fd = new FormData(); fd.append('board_id', boards[0].id); fd.append('file', new Blob([csv], { type: 'text/csv' }), 'asana.csv');
r = await call('admin', '/integrations/file', { method: 'POST', form: fd }); ok(r.j.stats?.created === 1 && r.j.stats.skipped === 1, `import CSV: ${JSON.stringify(r.j.stats)}`);
const trello = { lists: [{ id: 'l1', name: 'A fazer' }, { id: 'l2', name: 'Feito' }], members: [], cards: [{ id: 'c1', name: 'DRE gerencial', desc: '', idList: 'l1', due: null }, { id: 'c2', name: 'Velha', idList: 'l2' }] };
fd = new FormData(); fd.append('board_id', boards[0].id); fd.append('file', new Blob([JSON.stringify(trello)]), 'trello.json');
r = await call('admin', '/integrations/file', { method: 'POST', form: fd }); ok(r.j.stats?.created === 1, `import Trello: ${JSON.stringify(r.j.stats)}`);

const m = new Date(); const month = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
r = await call('admin', `/dashboard?month=${month}`); ok(r.s === 200 && r.j.summary.created >= 4 && r.j.by_assignee.length === 2, `KPIs: ${JSON.stringify(r.j.summary)}`);
r = await call('admin', '/dashboard/send-report', { method: 'POST', body: { month } }); ok(r.j.sent === 2, 'relatório mensal enviado p/ 2 pessoas');

r = await call('ana', '/chat/channels'); const geral = r.j.channels[0].id;
r = await call('ana', `/chat/channels/${geral}/messages`, { method: 'POST', form: (() => { const f = new FormData(); f.append('body', 'Olá equipe!'); return f; })() });
ok(r.s === 200, 'mensagem no #geral');
r = await call('admin', '/chat/channels'); ok(r.j.channels.find((c) => c.id === geral).unread === 1, 'contador de não lidas');
r = await call('admin', '/chat/dm', { method: 'POST', body: { user_id: anaId } }); ok(r.s === 200 && r.j.channel.type === 'direct', 'conversa direta criada');
r = await call('admin', '/users/invite', { method: 'POST', body: { email: 'bruno@ex.com' } });
r = await call('admin', '/auth/forgot', { method: 'POST', body: { email: 'ana@ex.com' } }); ok(r.s === 200, 'esqueci senha');
r = await call('ana', '/users/invite', { method: 'POST', body: { email: 'z@ex.com' } }); ok(r.s === 403, 'membro não convida');
