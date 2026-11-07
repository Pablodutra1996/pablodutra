import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { config } from './config.js';
import { q, now } from './db.js';
import { escapeHtml } from './util.js';

const brevoConfigured = !!config.brevo.apiKey;
const smtpConfigured = !brevoConfigured && !!config.smtp.host;
const transport = smtpConfigured
  ? nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    })
  : null;

const outbox = path.join(config.dataDir, 'outbox');
if (brevoConfigured) console.log('[mail] envio via API Brevo');
else if (!smtpConfigured) {
  fs.mkdirSync(outbox, { recursive: true });
  console.warn(`[mail] E-mail não configurado — mensagens serão gravadas em ${outbox}`);
}

/** "Nome <email@x.com>" -> { name, email } */
function parseFrom(from) {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  return m ? { name: m[1] || 'FinHub', email: m[2].trim() } : { name: 'FinHub', email: from.trim() };
}

async function sendViaBrevo({ to, subject, html }) {
  const res = await fetch(config.brevo.url, {
    method: 'POST',
    headers: { 'api-key': config.brevo.apiKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: parseFrom(config.smtp.from), to: [{ email: to }], subject, htmlContent: html }),
  });
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export async function sendMail({ to, subject, html }) {
  try {
    if (brevoConfigured) {
      await sendViaBrevo({ to, subject, html });
    } else if (transport) {
      await transport.sendMail({ from: config.smtp.from, to, subject, html });
    } else {
      const file = path.join(outbox, `${Date.now()}-${String(to).replace(/[^\w.@-]/g, '_')}.html`);
      fs.writeFileSync(file, `<!-- Para: ${to} | Assunto: ${subject} -->\n${html}`);
    }
    await q.run('INSERT INTO email_log (recipient, subject, status, created_at) VALUES (?,?,?,?)', to, subject, brevoConfigured || transport ? 'sent' : 'outbox', now());
    return true;
  } catch (err) {
    console.error('[mail] falha ao enviar:', err.message);
    await q.run('INSERT INTO email_log (recipient, subject, status, error, created_at) VALUES (?,?,?,?,?)', to, subject, 'error', err.message, now());
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

export const mailStatus = () => ({ smtpConfigured: smtpConfigured || brevoConfigured, provider: brevoConfigured ? 'Brevo (API)' : smtpConfigured ? 'SMTP' : null, outbox: smtpConfigured || brevoConfigured ? null : outbox });
