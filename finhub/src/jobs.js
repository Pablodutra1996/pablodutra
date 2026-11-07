/**
 * Rotinas automáticas.
 *
 * Funcionam mesmo em hospedagens que "dormem" (ex.: Render Free): a cada 15 minutos o
 * servidor verifica o que está pendente e grava no banco o que já foi feito. Se o site
 * estava dormindo no horário exato, a tarefa é executada assim que ele acordar.
 *
 *  - Lembretes de prazo ........ dias úteis, em horário comercial (cada tarefa no máx. 1x a cada 24h)
 *  - Relatório mensal .......... a partir do dia 1 às 08:00, uma única vez por mês
 *  - Backup do banco ........... 1x por dia (quando o storage é em nuvem)
 *  - Sync Microsoft To Do ...... a cada 15 minutos
 */
import cron from 'node-cron';
import { config } from './config.js';
import { dumpDatabase, getState, setState } from './db.js';
import { getStorage } from './storage.js';
import { sendTaskReminders, sendMonthlyReports } from './reports.js';
import { previousMonth } from './kpis.js';
import { syncAllMicrosoft } from './integrations.js';

/** Data/hora local (fuso configurado) */
function localNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short', hourCycle: 'h23',
    }).formatToParts(new Date()).map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, day: Number(parts.day), hour: Number(parts.hour), weekday: parts.weekday };
}

/** Backup do banco para o armazenamento (nuvem) */
export async function backupDatabase() {
  const { buffer, ext, mime } = await dumpDatabase();
  const key = `backups/finhub-${new Date().toISOString().slice(0, 10)}.${ext}`;
  await (await getStorage()).put(key, buffer, mime);
  await setState('last_backup_date', localNow().date);
  return key;
}

let running = false;
export async function tick() {
  if (running) return;
  running = true;
  const t = localNow();
  const results = {};
  try {
    const businessDay = !['Sat', 'Sun'].includes(t.weekday);
    if (businessDay && t.hour >= config.reminders.startHour && t.hour <= config.reminders.endHour) {
      results.lembretes = await sendTaskReminders();
    }
    const period = previousMonth();
    if ((t.day > 1 || t.hour >= config.monthlyReport.hour) && !(await getState(`monthly_report:${period}`))) {
      await setState(`monthly_report:${period}`, 'sending');
      results.relatorio_mensal = await sendMonthlyReports(period);
      await setState(`monthly_report:${period}`, new Date().toISOString());
    }
    if (config.backupEnabled && (await getState('last_backup_date')) !== t.date && t.hour >= 1) {
      results.backup = await backupDatabase();
    }
    await syncAllMicrosoft();
  } catch (err) {
    console.error('[jobs] erro:', err.message);
  } finally {
    running = false;
  }
  const done = Object.entries(results).filter(([, v]) => v && (typeof v !== 'object' || v.users || v.sent || v.total));
  if (done.length) console.log('[jobs]', JSON.stringify(Object.fromEntries(done)));
  return results;
}

export async function startJobs() {
  // Instalações novas: não disparar relatório de um mês anterior à existência da plataforma
  const period = previousMonth();
  if (!(await getState('installed_at'))) {
    await setState('installed_at', new Date().toISOString());
    await setState(`monthly_report:${period}`, 'skipped (instalação nova)');
  }
  cron.schedule('*/15 * * * *', tick, { timezone: config.timezone });
  setTimeout(tick, 20000); // verifica pendências logo após iniciar/acordar
  console.log(`[jobs] verificação a cada 15 min (fuso ${config.timezone}); backup diário: ${config.backupEnabled ? 'sim' : 'não'}`);
}
