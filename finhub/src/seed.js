/**
 * Dados de demonstração: 3 usuários e ~6 meses de tarefas com histórico.
 * Uso: npm run seed   (somente em banco vazio)
 * Logins: admin@finhub.local / Financeiro123 (e ana@ / bruno@ com a mesma senha)
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { q, tx } from './db.js';
import { CATEGORIES } from './config.js';

if (q.get('SELECT COUNT(*) c FROM users').c > 0) {
  console.log('Banco já possui usuários — seed ignorado.');
  process.exit(0);
}

const hash = bcrypt.hashSync('Financeiro123', 10);
const iso = (d) => new Date(d).toISOString();
const DAY = 86400000;
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const TEMPLATES = {
  'Contas a Pagar': ['Programar pagamentos da semana', 'Conferir boletos de fornecedores', 'Aprovar lote de pagamentos'],
  'Contas a Receber': ['Cobrança de clientes em atraso', 'Baixa de recebimentos', 'Emitir faturas do mês'],
  'Conciliação Bancária': ['Conciliação bancária — Itaú', 'Conciliação bancária — Bradesco', 'Conciliar cartões corporativos'],
  'Fechamento Contábil': ['Fechamento contábil mensal', 'Provisões de férias e 13º', 'Revisar balancete'],
  'Fiscal / Tributário': ['Apurar PIS/COFINS', 'Emitir DARF de IRRF', 'Enviar SPED Fiscal'],
  'Orçamento / Forecast': ['Atualizar forecast trimestral', 'Revisar orçado x realizado'],
  'Relatórios Gerenciais': ['DRE gerencial do mês', 'Relatório de fluxo de caixa para a diretoria'],
  Tesouraria: ['Projeção de caixa semanal', 'Renovar aplicação CDB'],
  'Auditoria / Compliance': ['Responder solicitações da auditoria'],
};

tx(() => {
  const now = Date.now();
  const mk = (name, email, role, color) =>
    Number(q.run('INSERT INTO users (name,email,password_hash,role,color,created_at) VALUES (?,?,?,?,?,?)',
      name, email, hash, role, color, iso(now - 200 * DAY)).lastInsertRowid);
  const users = [
    mk('Pablo Dutra', 'admin@finhub.local', 'admin', '#4f46e5'),
    mk('Ana Souza', 'ana@finhub.local', 'member', '#0f6cbd'),
    mk('Bruno Lima', 'bruno@finhub.local', 'member', '#00a37a'),
  ];
  const board = (name, color, desc) =>
    Number(q.run('INSERT INTO boards (name,description,color,created_by,created_at) VALUES (?,?,?,?,?)', name, desc, color, users[0], iso(now - 200 * DAY)).lastInsertRowid);
  const boards = [
    board('Rotinas Financeiras', '#4f46e5', 'Atividades recorrentes da área'),
    board('Fechamento Mensal', '#059669', 'Checklist de fechamento contábil'),
    board('Projetos e Melhorias', '#d97706', 'Iniciativas da área'),
  ];
  const hist = (taskId, from, to, uid, at, note = null) =>
    q.run('INSERT INTO task_history (task_id,from_status,to_status,user_id,note,created_at) VALUES (?,?,?,?,?,?)', taskId, from, to, uid, note, iso(at));

  let pos = 1;
  for (let i = 0; i < 150; i++) {
    const cat = pick(CATEGORIES.slice(0, 9));
    const title = pick(TEMPLATES[cat]);
    const assignee = pick(users);
    const created = now - rnd(0, 175) * DAY;
    const due = created + rnd(2, 15) * DAY;
    const age = now - created;
    const doneChance = due < now ? 0.86 : 0.3;
    const isDone = Math.random() < doneChance && age > 2 * DAY;
    const startedAt = created + rnd(0.1, 0.4) * (Math.min(due, now) - created);
    let completedAt = null;
    if (isDone) {
      completedAt = Math.min(now - 3600000, due + (Math.random() < 0.8 ? -rnd(0, 2) : rnd(0.5, 5)) * DAY);
      if (completedAt <= startedAt) completedAt = startedAt + rnd(2, 30) * 3600000;
      if (completedAt > now) completedAt = now - 3600000;
    }
    const status = isDone ? 'done' : pick(['todo', 'doing', 'doing', 'waiting']);
    const id = Number(q.run(`INSERT INTO tasks (board_id,title,description,status,priority,category,assignee_id,created_by,due_date,started_at,
        completed_at,completion_note,position,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      pick(boards), title, 'Tarefa de demonstração.', status, pick(['baixa', 'media', 'media', 'alta', 'urgente']), cat, assignee, users[0],
      iso(due), status === 'todo' ? null : iso(startedAt), completedAt ? iso(completedAt) : null,
      isDone ? 'Atividade realizada; comprovante anexado.' : null, pos++, iso(created), iso(completedAt || created)).lastInsertRowid);
    hist(id, null, 'todo', users[0], created, 'Tarefa criada');
    if (status !== 'todo') hist(id, 'todo', 'doing', assignee, startedAt);
    if (isDone && Math.random() < 0.3) {
      const w = startedAt + (completedAt - startedAt) * 0.4;
      hist(id, 'doing', 'waiting', assignee, w);
      hist(id, 'waiting', 'doing', assignee, startedAt + (completedAt - startedAt) * 0.7);
    } else if (status === 'waiting') hist(id, 'doing', 'waiting', assignee, startedAt + 3600000);
    if (isDone) {
      const fileId = Number(q.run('INSERT INTO files (storage_key,filename,mime,size,uploaded_by,created_at) VALUES (?,?,?,?,?,?)',
        `seed/${crypto.randomUUID()}.pdf`, 'comprovante.pdf', 'application/pdf', 48213, assignee, iso(completedAt)).lastInsertRowid);
      q.run('INSERT INTO task_attachments (task_id,file_id,is_evidence,created_at) VALUES (?,?,1,?)', id, fileId, iso(completedAt));
      hist(id, 'doing', 'done', assignee, completedAt, 'Atividade realizada; comprovante anexado.');
    }
  }
  const geral = q.get(`SELECT id FROM channels WHERE name='geral'`).id;
  const msgs = [
    [users[0], 'Bom dia, pessoal! Hoje começamos o fechamento de outubro.'],
    [users[1], 'Bom dia! Já subi a conciliação do Itaú com evidência.'],
    [users[2], 'Estou finalizando a apuração do PIS/COFINS, devo concluir até as 15h.'],
    [users[0], 'Perfeito. Às 16h fazemos uma call rápida para revisar o DRE.'],
  ];
  msgs.forEach(([u, b], i) => q.run('INSERT INTO messages (channel_id,user_id,body,created_at) VALUES (?,?,?,?)', geral, u, b, iso(now - (60 - i * 10) * 60000)));
});
console.log('Seed concluído. Login: admin@finhub.local / Financeiro123 (também ana@finhub.local e bruno@finhub.local).');
