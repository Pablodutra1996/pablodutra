import fs from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import { config } from './config.js';
import { db } from './db.js';
import { getStorage } from './storage.js';
import { sendTaskReminders, sendMonthlyReports } from './reports.js';
import { previousMonth } from './kpis.js';
import { syncAllMicrosoft } from './integrations.js';

const safe = (name, fn) => async () => {
  try {
    const res = await fn();
    console.log(`[job] ${name} ok`, res ?? '');
  } catch (err) {
    console.error(`[job] ${name} falhou:`, err.message);
  }
};

/** Backup diário do banco para o armazenamento em nuvem */
export async function backupDatabase() {
  const tmp = path.join(config.dataDir, `backup-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  const key = `backups/finhub-${new Date().toISOString().slice(0, 10)}.db`;
  await (await getStorage()).put(key, await fs.promises.readFile(tmp), 'application/x-sqlite3');
  await fs.promises.rm(tmp, { force: true });
  return key;
}

export function startJobs() {
  const tz = { timezone: config.timezone };
  cron.schedule(config.reminders.cron, safe('lembretes de prazo', sendTaskReminders), tz);
  cron.schedule(config.monthlyReportCron, safe('relatório mensal', () => sendMonthlyReports(previousMonth())), tz);
  cron.schedule(config.microsoft.syncCron, safe('sync Microsoft To Do', syncAllMicrosoft), tz);
  if (config.backupEnabled) cron.schedule('0 2 * * *', safe('backup do banco', backupDatabase), tz);
  console.log(`[jobs] agendados (fuso ${config.timezone}): lembretes "${config.reminders.cron}", relatório mensal "${config.monthlyReportCron}", sync To Do "${config.microsoft.syncCron}"${config.backupEnabled ? ', backup diário 02:00' : ''}`);
}
