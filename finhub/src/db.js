/**
 * Camada de banco de dados com dois motores, mesma interface (assíncrona):
 *  - PostgreSQL (Supabase, Neon, Render, Azure...) quando DATABASE_URL estiver definido
 *  - SQLite em arquivo (desenvolvimento local / servidor com disco), caso contrário
 *
 * As consultas usam "?" como marcador; para o PostgreSQL ele é convertido em $1, $2...
 */
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from './config.js';

export const now = () => new Date().toISOString();
export const dialect = process.env.DATABASE_URL ? 'postgres' : 'sqlite';

// ---------------------------------------------------------------- Esquema
const TABLES = [
  ['users', `
    id {PK}, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT,
    role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'active', color TEXT,
    notify_email INTEGER NOT NULL DEFAULT 1, avatar_file_id INTEGER, last_seen_at TEXT, created_at TEXT NOT NULL`],
  ['invites', `
    id {PK}, email TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', token TEXT NOT NULL UNIQUE,
    invited_by INTEGER REFERENCES users(id), expires_at TEXT NOT NULL, accepted_at TEXT, created_at TEXT NOT NULL`],
  ['password_resets', `
    id {PK}, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL`],
  ['boards', `
    id {PK}, name TEXT NOT NULL, description TEXT, color TEXT, archived INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL`],
  ['tasks', `
    id {PK}, board_id INTEGER NOT NULL REFERENCES boards(id), title TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL DEFAULT 'todo', priority TEXT NOT NULL DEFAULT 'media', category TEXT,
    assignee_id INTEGER REFERENCES users(id), created_by INTEGER REFERENCES users(id), due_date TEXT,
    started_at TEXT, completed_at TEXT, completion_note TEXT, recurrence TEXT NOT NULL DEFAULT 'none',
    position {REAL} NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'manual', external_id TEXT,
    last_overdue_notice_at TEXT, due_soon_notice_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL`],
  ['task_history', `
    id {PK}, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, from_status TEXT,
    to_status TEXT NOT NULL, user_id INTEGER REFERENCES users(id), note TEXT, created_at TEXT NOT NULL`],
  ['files', `
    id {PK}, storage_key TEXT NOT NULL, filename TEXT NOT NULL, mime TEXT, size INTEGER,
    uploaded_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL`],
  ['task_attachments', `
    id {PK}, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, file_id INTEGER NOT NULL REFERENCES files(id),
    is_evidence INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL`],
  ['task_comments', `
    id {PK}, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id),
    body TEXT NOT NULL, created_at TEXT NOT NULL`],
  ['channels', `
    id {PK}, name TEXT, type TEXT NOT NULL DEFAULT 'public', dm_key TEXT UNIQUE,
    created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL`],
  ['channel_members', `
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, last_read_at TEXT, PRIMARY KEY (channel_id, user_id)`],
  ['messages', `
    id {PK}, channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id),
    body TEXT, file_id INTEGER REFERENCES files(id), kind TEXT NOT NULL DEFAULT 'text', created_at TEXT NOT NULL`],
  ['integrations', `
    id {PK}, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, provider TEXT NOT NULL,
    access_token TEXT, refresh_token TEXT, expires_at TEXT, account_email TEXT, settings TEXT NOT NULL DEFAULT '{}',
    last_sync_at TEXT, last_sync_status TEXT, created_at TEXT NOT NULL, UNIQUE (user_id, provider)`],
  ['notifications', `
    id {PK}, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, body TEXT,
    link TEXT, read_at TEXT, created_at TEXT NOT NULL`],
  ['kpi_reports', `id {PK}, period TEXT NOT NULL, user_id INTEGER, data TEXT NOT NULL, sent_at TEXT, created_at TEXT NOT NULL`],
  ['email_log', `id {PK}, recipient TEXT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL`],
  // Estado das rotinas automáticas (último backup, relatório mensal já enviado...)
  ['app_state', `key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL`],
];
export const TABLE_NAMES = TABLES.map(([t]) => t);
// Tabelas sem coluna "id" (não usam RETURNING id)
const NO_ID = new Set(['channel_members', 'app_state']);

const INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email_lower ON users (LOWER(email));
CREATE UNIQUE INDEX IF NOT EXISTS ux_tasks_external ON tasks(source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_tasks_board ON tasks(board_id, status);
CREATE INDEX IF NOT EXISTS ix_tasks_assignee ON tasks(assignee_id, status);
CREATE INDEX IF NOT EXISTS ix_history_task ON task_history(task_id, created_at);
CREATE INDEX IF NOT EXISTS ix_messages_channel ON messages(channel_id, id);
CREATE INDEX IF NOT EXISTS ix_notifications_user ON notifications(user_id, id);`;

function schemaSql() {
  const pk = dialect === 'postgres' ? 'INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const real = dialect === 'postgres' ? 'DOUBLE PRECISION' : 'REAL';
  return TABLES.map(([name, cols]) =>
    `CREATE TABLE IF NOT EXISTS ${name} (${cols.replaceAll('{PK}', pk).replaceAll('{REAL}', real)});`).join('\n') + INDEXES;
}

// ---------------------------------------------------------------- Motores
const als = new AsyncLocalStorage();
let engine;

async function initPostgres() {
  const pg = (await import('pg')).default;
  // COUNT(*) e afins retornam bigint (int8): converter para number
  pg.types.setTypeParser(20, (v) => Number(v));
  pg.types.setTypeParser(1700, (v) => Number(v));
  const url = process.env.DATABASE_URL;
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    ssl: local || process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: Number(process.env.DATABASE_POOL_MAX || 5),
    idleTimeoutMillis: 30000,
  });
  pool.on('error', (err) => console.error('[db] erro no pool:', err.message));
  const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
  const exec = (client, sql, params) => client.query(toPg(sql), params);
  const runner = () => als.getStore() || pool;
  return {
    name: 'postgres',
    async all(sql, params) { return (await exec(runner(), sql, params)).rows; },
    async get(sql, params) { return (await exec(runner(), sql, params)).rows[0]; },
    async run(sql, params) {
      let text = sql;
      const ins = /^\s*INSERT\s+INTO\s+(\w+)/i.exec(sql);
      if (ins && !NO_ID.has(ins[1]) && !/RETURNING/i.test(sql)) text += ' RETURNING id';
      const res = await exec(runner(), text, params);
      return { changes: res.rowCount, lastInsertRowid: res.rows?.[0]?.id };
    },
    async exec(sql) { await pool.query(sql); },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await als.run(client, fn);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async close() { await pool.end(); },
  };
}

async function initSqlite() {
  const { DatabaseSync } = await import('node:sqlite');
  fs.mkdirSync(config.dataDir, { recursive: true });
  const file = path.join(config.dataDir, 'finhub.db');
  const sdb = new DatabaseSync(file);
  sdb.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return {
    name: 'sqlite',
    file,
    raw: sdb,
    async all(sql, params) { return sdb.prepare(sql).all(...params); },
    async get(sql, params) { return sdb.prepare(sql).get(...params); },
    async run(sql, params) {
      const r = sdb.prepare(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    async exec(sql) { sdb.exec(sql); },
    // Conexão única: as instruções do callback rodam em sequência dentro da transação
    async tx(fn) {
      sdb.exec('BEGIN');
      try {
        const result = await fn();
        sdb.exec('COMMIT');
        return result;
      } catch (err) {
        sdb.exec('ROLLBACK');
        throw err;
      }
    },
    async close() { sdb.close(); },
  };
}

/** Executa migrações de bancos SQLite criados por versões anteriores */
async function migrateSqlite() {
  const cols = engine.raw.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('avatar_file_id')) engine.raw.exec('ALTER TABLE users ADD COLUMN avatar_file_id INTEGER');
}

export async function initDb() {
  if (engine) return engine;
  engine = dialect === 'postgres' ? await initPostgres() : await initSqlite();
  await engine.exec(schemaSql().replace(/^.*ux_users_email_lower.*$/m, ''));
  if (engine.name === 'sqlite') await migrateSqlite();
  // índice de e-mail sem diferenciar maiúsculas (só cria se ainda não houver duplicidade)
  try { await engine.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email_lower ON users (LOWER(email));'); } catch { /* ignora */ }
  if (!(await q.get(`SELECT id FROM channels WHERE type='public' AND name='geral'`))) {
    await q.run(`INSERT INTO channels (name, type, created_at) VALUES ('geral', 'public', ?)`, now());
  }
  console.log(`[db] banco: ${engine.name}${engine.file ? ` (${engine.file})` : ''}`);
  return engine;
}

export const q = {
  all: (sql, ...params) => engine.all(sql, params),
  get: (sql, ...params) => engine.get(sql, params),
  run: (sql, ...params) => engine.run(sql, params),
};

export const tx = (fn) => engine.tx(fn);

export const getState = async (key) => (await q.get('SELECT value FROM app_state WHERE key=?', key))?.value ?? null;
export const setState = (key, value) =>
  q.run(`INSERT INTO app_state (key, value, updated_at) VALUES (?,?,?)
         ON CONFLICT (key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, key, String(value), now());
export const dbEngine = () => engine;

/** Backup: SQLite → cópia do arquivo; PostgreSQL → exportação JSON de todas as tabelas */
export async function dumpDatabase() {
  if (engine.name === 'sqlite') {
    const tmp = path.join(config.dataDir, `backup-${Date.now()}.db`);
    engine.raw.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const buffer = await fs.promises.readFile(tmp);
    await fs.promises.rm(tmp, { force: true });
    return { buffer, ext: 'db', mime: 'application/x-sqlite3' };
  }
  const data = { exported_at: now(), dialect: engine.name, tables: {} };
  for (const t of TABLE_NAMES) data.tables[t] = await q.all(`SELECT * FROM ${t}`);
  return { buffer: Buffer.from(JSON.stringify(data)), ext: 'json', mime: 'application/json' };
}
