import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { config } from './config.js';
import { q, now } from './db.js';
import { escapeHtml } from './util.js';

const smtpConfigured = !!config.smtp.host;
const transport = smtpConfigured
  ? nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    })
  : null;

const outbox = path.join(config.dataDir, 'outbox');
if (!smtpConfigured) {
  fs.mkdirSync(outbox, { recursive: true });
  console.warn(`[mail] SMTP não configurado — e-mails serão gravados em ${outbox}`);
}

export async function sendMail({ to, subject, html }) {
  try {
    if (transport) {
      await transport.sendMail({ from: config.smtp.from, to, subject, html });
    } else {
      const file = path.join(outbox, `${Date.now()}-${String(to).replace(/[^\w.@-]/g, '_')}.html`);
      fs.writeFileSync(file, `<!-- Para: ${to} | Assunto: ${subject} -->\n${html}`);
    }
    q.run('INSERT INTO email_log (recipient, subject, status, created_at) VALUES (?,?,?,?)', to, subject, transport ? 'sent' : 'outbox', now());
    return true;
  } catch (err) {
    console.error('[mail] falha ao enviar:', err.message);
    q.run('INSERT INTO email_log (recipient, subject, status, error, created_at) VALUES (?,?,?,?,?)', to, subject, 'error', err.message, now());
    return false;
  }
}

/** Layout padrão dos e-mails */
export function layout({ title, intro = '', body = '', cta }) {
  return `<!doctype html><html><body style="margin:0;background:#f3f4f8;font-family:Segoe UI,Arial,sans-serif;color:#1f2937">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0"><tr><td align="center">
<table width="620" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
<tr><td style="background:#4f46e5;padding:18px 28px;color:#fff;font-size:18px;font-weight:700">FinHub · Gestão Financeira</td></tr>
<tr><td style="padding:28px">
<h2 style="margin:0 0 12px;font-size:20px">${escapeHtml(title)}</h2>
${intro ? `<p style="margin:0 0 16px;line-height:1.5">${intro}</p>` : ''}
${body}
${cta ? `<p style="margin:24px 0 0"><a href="${cta.url}" style="background:#4f46e5;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">${escapeHtml(cta.label)}</a></p>` : ''}
</td></tr>
<tr><td style="padding:16px 28px;background:#f9fafb;color:#6b7280;font-size:12px">Mensagem automática do FinHub. <a href="${config.appUrl}" style="color:#4f46e5">${config.appUrl}</a></td></tr>
</table></td></tr></table></body></html>`;
}

export const mailStatus = () => ({ smtpConfigured, outbox: smtpConfigured ? null : outbox });
