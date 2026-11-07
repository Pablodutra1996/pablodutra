import { Router } from 'express';
import { q } from '../db.js';
import { requireAdmin } from '../auth.js';
import { fail } from '../util.js';
import { computeKpis, currentMonth } from '../kpis.js';
import { sendMonthlyReports, sendTaskReminders } from '../reports.js';
import { mailStatus } from '../mailer.js';
import { backupDatabase } from '../jobs.js';

const r = Router();

r.get('/', async (req, res) => {
  const month = String(req.query.month || currentMonth());
  const userId = req.query.user_id ? Number(req.query.user_id) : null;
  if (userId && !await q.get('SELECT id FROM users WHERE id=?', userId)) fail(404, 'Usuário não encontrado.');
  res.json(await computeKpis(month, userId));
});

r.get('/reports', async (req, res) => {
  res.json({
    reports: await q.all(`SELECT r.id, r.period, r.user_id, r.sent_at, u.name user_name FROM kpi_reports r LEFT JOIN users u ON u.id=r.user_id
      ORDER BY r.id DESC LIMIT 50`),
  });
});

// Ações manuais para administradores (testar e-mails, reenviar relatórios)
r.post('/send-report', requireAdmin, async (req, res) => {
  const month = String(req.body?.month || currentMonth());
  res.json(await sendMonthlyReports(month, { onlyUserId: req.body?.only_me ? req.user.id : undefined }));
});

r.post('/run-reminders', requireAdmin, async (req, res) => {
  res.json(await sendTaskReminders());
});

r.post('/backup', requireAdmin, async (req, res) => {
  res.json({ key: await backupDatabase() });
});

r.get('/system', requireAdmin, async (req, res) => {
  res.json({
    mail: mailStatus(),
    emails: await q.all('SELECT * FROM email_log ORDER BY id DESC LIMIT 30'),
  });
});

export default r;
