/**
 * Importação de tarefas de outras plataformas.
 *  - Microsoft To Do: OAuth2 + Microsoft Graph, com sincronização automática periódica
 *  - CSV (Asana, Monday, Planner, Excel, ClickUp...) e JSON do Trello
 */
import jwt from 'jsonwebtoken';
import { parse } from 'csv-parse/sync';
import { config, CATEGORIES } from './config.js';
import { q, now, tx } from './db.js';
import { toIso } from './util.js';
import { emitAll } from './realtime.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const AUTH = () => `https://login.microsoftonline.com/${config.microsoft.tenant}/oauth2/v2.0`;
const SCOPES = 'offline_access User.Read Tasks.Read';

export const microsoftEnabled = () => !!(config.microsoft.clientId && config.microsoft.clientSecret);

// ---------- Utilidades comuns ----------
export async function ensureImportBoard(name) {
  const b = await q.get('SELECT id FROM boards WHERE name=? AND archived=0', name);
  if (b) return b.id;
  return Number((await q.run('INSERT INTO boards (name, description, color, created_at) VALUES (?,?,?,?)',
    name, 'Tarefas importadas automaticamente', '#0f6cbd', now())).lastInsertRowid);
}

/** Cria ou atualiza tarefa importada. Tarefas importadas nunca entram como concluídas (regra da evidência). */
async function upsertImported({ source, externalId, boardId, title, description, dueDate, priority, status, category, assigneeId, userId }) {
  const existing = externalId ? await q.get('SELECT * FROM tasks WHERE source=? AND external_id=?', source, externalId) : null;
  if (existing) {
    if (existing.status === 'done') return 'skipped';
    const changed = existing.title !== title || (existing.description || '') !== (description || '') ||
      (existing.due_date || null) !== (dueDate || null) || existing.priority !== priority;
    if (!changed) return 'unchanged';
    await q.run('UPDATE tasks SET title=?, description=?, due_date=?, priority=?, updated_at=? WHERE id=?',
      title, description, dueDate, priority, now(), existing.id);
    return 'updated';
  }
  const pos = (await q.get('SELECT COALESCE(MAX(position),0)+1 p FROM tasks WHERE board_id=?', boardId)).p;
  const info = await q.run(`INSERT INTO tasks (board_id, title, description, status, priority, category, assignee_id, created_by, due_date,
      position, source, external_id, started_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    boardId, title, description, status, priority, category, assigneeId, userId, dueDate, pos, source, externalId,
    status === 'doing' ? now() : null, now(), now());
  await q.run('INSERT INTO task_history (task_id, from_status, to_status, user_id, note, created_at) VALUES (?,?,?,?,?,?)',
    info.lastInsertRowid, null, status, userId, `Importada (${source})`, now());
  return 'created';
}

const guessCategory = (text = '') => {
  const t = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const rules = [
    [/pagar|fornecedor|boleto|pagamento/, 'Contas a Pagar'],
    [/receber|cobranca|faturamento|cliente/, 'Contas a Receber'],
    [/concilia|extrato|banco/, 'Conciliação Bancária'],
    [/fechamento|contab|balancete|lancamento/, 'Fechamento Contábil'],
    [/imposto|fiscal|tribut|icms|iss|pis|cofins|darf|sped|nf/, 'Fiscal / Tributário'],
    [/orcamento|forecast|budget|projec/, 'Orçamento / Forecast'],
    [/relatorio|dre|kpi|indicador|report/, 'Relatórios Gerenciais'],
    [/caixa|tesour|aplica|fluxo/, 'Tesouraria'],
    [/auditor|compliance|controle interno/, 'Auditoria / Compliance'],
  ];
  return rules.find(([re]) => re.test(t))?.[1] || null;
};

// ---------- Microsoft To Do ----------
export function microsoftAuthUrl(userId) {
  const state = jwt.sign({ uid: userId, p: 'ms' }, config.jwtSecret, { expiresIn: '10m' });
  const params = new URLSearchParams({
    client_id: config.microsoft.clientId,
    response_type: 'code',
    redirect_uri: config.microsoft.redirectUri,
    response_mode: 'query',
    scope: SCOPES,
    state,
    prompt: 'select_account',
  });
  return `${AUTH()}/authorize?${params}`;
}

async function tokenRequest(params) {
  const res = await fetch(`${AUTH()}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.microsoft.clientId,
      client_secret: config.microsoft.clientSecret,
      redirect_uri: config.microsoft.redirectUri,
      scope: SCOPES,
      ...params,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Falha na autenticação Microsoft');
  return data;
}

export async function microsoftCallback(code, state) {
  const { uid } = jwt.verify(state, config.jwtSecret);
  const tok = await tokenRequest({ code, grant_type: 'authorization_code' });
  const me = await (await fetch(`${GRAPH}/me`, { headers: { Authorization: `Bearer ${tok.access_token}` } })).json();
  const expires = new Date(Date.now() + (tok.expires_in - 60) * 1000).toISOString();
  await q.run(`INSERT INTO integrations (user_id, provider, access_token, refresh_token, expires_at, account_email, settings, created_at)
         VALUES (?, 'microsoft_todo', ?, ?, ?, ?, '{"auto_sync":true}', ?)
         ON CONFLICT(user_id, provider) DO UPDATE SET access_token=excluded.access_token, refresh_token=excluded.refresh_token,
           expires_at=excluded.expires_at, account_email=excluded.account_email`,
    uid, tok.access_token, tok.refresh_token, expires, me.mail || me.userPrincipalName || '', now());
  return uid;
}

async function accessToken(integ) {
  if (integ.expires_at > now()) return integ.access_token;
  const tok = await tokenRequest({ refresh_token: integ.refresh_token, grant_type: 'refresh_token' });
  const expires = new Date(Date.now() + (tok.expires_in - 60) * 1000).toISOString();
  await q.run('UPDATE integrations SET access_token=?, refresh_token=COALESCE(?, refresh_token), expires_at=? WHERE id=?',
    tok.access_token, tok.refresh_token || null, expires, integ.id);
  return tok.access_token;
}

async function graphAll(integ, url) {
  const token = await accessToken(integ);
  const items = [];
  let next = `${GRAPH}${url}`;
  while (next) {
    const res = await fetch(next, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Erro Graph ${res.status}`);
    items.push(...(data.value || []));
    next = data['@odata.nextLink'];
  }
  return items;
}

export const getMicrosoftIntegration = (userId) =>
  q.get(`SELECT * FROM integrations WHERE user_id=? AND provider='microsoft_todo'`, userId);

export async function microsoftLists(userId) {
  const integ = await getMicrosoftIntegration(userId);
  if (!integ) throw new Error('Microsoft To Do não conectado');
  return (await graphAll(integ, '/me/todo/lists')).map((l) => ({ id: l.id, name: l.displayName, wellknown: l.wellknownListName }));
}

export async function syncMicrosoft(integ) {
  const settings = JSON.parse(integ.settings || '{}');
  const boardId = settings.board_id && (await q.get('SELECT id FROM boards WHERE id=? AND archived=0', settings.board_id))
    ? settings.board_id
    : await ensureImportBoard('Importadas · Microsoft To Do');
  const stats = { created: 0, updated: 0, skipped: 0, unchanged: 0 };
  try {
    let lists = await graphAll(integ, '/me/todo/lists');
    if (settings.lists?.length) lists = lists.filter((l) => settings.lists.includes(l.id));
    for (const list of lists) {
      const items = await graphAll(integ, `/me/todo/lists/${encodeURIComponent(list.id)}/tasks?$top=100`);
      await tx(async () => {
        for (const t of items) {
          if (t.status === 'completed') { stats.skipped++; continue; }
          const due = t.dueDateTime?.dateTime ? toIso(t.dueDateTime.dateTime.slice(0, 10)) : null;
          const desc = [t.body?.content?.trim(), `— Importado do Microsoft To Do (lista "${list.displayName}")`].filter(Boolean).join('\n\n');
          const result = await upsertImported({
            source: 'microsoft_todo',
            externalId: t.id,
            boardId,
            title: t.title || '(sem título)',
            description: desc,
            dueDate: due,
            priority: t.importance === 'high' ? 'alta' : t.importance === 'low' ? 'baixa' : 'media',
            status: t.status === 'inProgress' ? 'doing' : t.status === 'waitingOnOthers' ? 'waiting' : 'todo',
            category: guessCategory(`${list.displayName} ${t.title}`),
            assigneeId: integ.user_id,
            userId: integ.user_id,
          });
          stats[result]++;
        }
      });
    }
    await q.run('UPDATE integrations SET last_sync_at=?, last_sync_status=? WHERE id=?', now(),
      `OK: ${stats.created} novas, ${stats.updated} atualizadas`, integ.id);
    if (stats.created || stats.updated) emitAll('boards:changed', {});
    return stats;
  } catch (err) {
    await q.run('UPDATE integrations SET last_sync_at=?, last_sync_status=? WHERE id=?', now(), `Erro: ${err.message}`, integ.id);
    throw err;
  }
}

export async function syncAllMicrosoft() {
  if (!microsoftEnabled()) return;
  for (const integ of await q.all(`SELECT * FROM integrations WHERE provider='microsoft_todo'`)) {
    if (JSON.parse(integ.settings || '{}').auto_sync === false) continue;
    try {
      await syncMicrosoft(integ);
    } catch (err) {
      console.error(`[ms-todo] sync user ${integ.user_id}:`, err.message);
    }
  }
}

// ---------- CSV / Trello ----------
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const COLS = {
  title: ['titulo', 'tarefa', 'title', 'name', 'nome', 'task name', 'task', 'item', 'assunto', 'subject'],
  description: ['descricao', 'description', 'notes', 'notas', 'observacoes', 'observacao', 'detalhes'],
  due: ['vencimento', 'prazo', 'due date', 'due', 'data de vencimento', 'data limite', 'data de conclusao prevista', 'deadline', 'date', 'data'],
  assignee: ['responsavel', 'assignee', 'assignee email', 'assigned to', 'atribuido a', 'email', 'owner', 'person', 'pessoa'],
  priority: ['prioridade', 'priority'],
  category: ['categoria', 'category', 'section/column', 'grupo', 'group', 'bucket name', 'nome do bucket'],
  status: ['status', 'progresso', 'progress', 'completed at', 'concluido'],
};
const pick = (row, key) => {
  for (const alias of COLS[key]) {
    const k = Object.keys(row).find((h) => norm(h) === alias);
    if (k && String(row[k]).trim()) return String(row[k]).trim();
  }
  return '';
};

function parseDateFlexible(s) {
  if (!s) return null;
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s);
  if (br) {
    const y = br[3].length === 2 ? `20${br[3]}` : br[3];
    return toIso(`${y}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`);
  }
  try { return toIso(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s : s.replace(' ', 'T')); } catch { return null; }
}

const mapPriority = (s) => {
  const p = norm(s);
  if (/urgent|critic/.test(p)) return 'urgente';
  if (/alta|high|import/.test(p)) return 'alta';
  if (/baixa|low/.test(p)) return 'baixa';
  return 'media';
};
const isDone = (s) => /^(done|concluid|complet|feito|finaliz|true|sim|yes)/.test(norm(s)) || /^\d{4}-\d{2}-\d{2}/.test(s);
const mapStatus = (s) => (/andamento|progress|doing|working/.test(norm(s)) ? 'doing' : /aguard|wait|bloq|stuck/.test(norm(s)) ? 'waiting' : 'todo');

async function findUser(value) {
  if (!value) return null;
  return (await q.get(`SELECT id FROM users WHERE status='active' AND (LOWER(email)=LOWER(?) OR LOWER(name)=LOWER(?))`, value, value))?.id || null;
}

export async function importFile({ buffer, filename, boardId, user }) {
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  const stats = { created: 0, updated: 0, skipped: 0, unchanged: 0, errors: [] };
  const isJson = /\.json$/i.test(filename) || text.trim().startsWith('{');

  await tx(async () => {
    if (isJson) {
      // Exportação JSON do Trello (Menu > Imprimir, exportar e compartilhar > Exportar como JSON)
      const data = JSON.parse(text);
      if (!Array.isArray(data.cards)) throw new Error('JSON não reconhecido. Use a exportação JSON de um quadro do Trello.');
      const lists = Object.fromEntries((data.lists || []).map((l) => [l.id, l]));
      const members = Object.fromEntries((data.members || []).map((m) => [m.id, m.fullName]));
      for (const c of data.cards) {
        const list = lists[c.idList];
        if (c.closed || list?.closed || c.dueComplete || /feito|conclu|done|finaliz/.test(norm(list?.name))) { stats.skipped++; continue; }
        stats[await upsertImported({
          source: 'trello', externalId: c.id, boardId,
          title: c.name, description: c.desc || '', dueDate: c.due ? toIso(c.due) : null,
          priority: 'media', status: mapStatus(list?.name), category: guessCategory(`${list?.name} ${c.name}`),
          assigneeId: await findUser(members[c.idMembers?.[0]]), userId: user.id,
        })]++;
      }
      return;
    }
    const firstLine = text.split(/\r?\n/)[0] || '';
    const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
    const rows = parse(text, { columns: true, skip_empty_lines: true, delimiter, relax_column_count: true, trim: true });
    for (const [i, row] of rows.entries()) {
      const title = pick(row, 'title');
      if (!title) { stats.errors.push(`Linha ${i + 2}: sem título`); continue; }
      const status = pick(row, 'status');
      if (status && isDone(status)) { stats.skipped++; continue; }
      const cat = pick(row, 'category');
      stats[await upsertImported({
        source: 'csv', externalId: null, boardId, title,
        description: pick(row, 'description'), dueDate: parseDateFlexible(pick(row, 'due')),
        priority: mapPriority(pick(row, 'priority')), status: mapStatus(status),
        category: CATEGORIES.find((c) => norm(c) === norm(cat)) || guessCategory(`${cat} ${title}`),
        assigneeId: await findUser(pick(row, 'assignee')), userId: user.id,
      })]++;
    }
  });
  emitAll('boards:changed', {});
  return stats;
}
