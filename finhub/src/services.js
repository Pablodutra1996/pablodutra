import crypto from 'node:crypto';
import multer from 'multer';
import { config } from './config.js';
import { q, now } from './db.js';
import { getStorage, safeFilename } from './storage.js';
import { sendMail, layout } from './mailer.js';
import { emitToUser } from './realtime.js';

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 10 },
});

/** Grava arquivo no storage (local/nuvem) e registra na tabela files */
export async function saveFile(file, { prefix, userId }) {
  // multer entrega o nome em latin1; corrige acentuação
  const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
  const key = `${prefix}/${crypto.randomUUID()}-${safeFilename(original)}`;
  const storage = await getStorage();
  await storage.put(key, file.buffer, file.mimetype);
  const info = await q.run(
    'INSERT INTO files (storage_key, filename, mime, size, uploaded_by, created_at) VALUES (?,?,?,?,?,?)',
    key, original, file.mimetype, file.size, userId, now()
  );
  return Number(info.lastInsertRowid);
}

/** Notificação in-app (+ e-mail opcional) */
export async function notify(userId, { title, body = '', link = '', email = false, emailHtml }) {
  if (!userId) return;
  const info = await q.run('INSERT INTO notifications (user_id, title, body, link, created_at) VALUES (?,?,?,?,?)', userId, title, body, link, now());
  emitToUser(userId, 'notification', { id: Number(info.lastInsertRowid), title, body, link, created_at: now() });
  if (email) {
    const user = await q.get('SELECT email, notify_email, status FROM users WHERE id=?', userId);
    if (user && user.status === 'active' && user.notify_email) {
      await sendMail({
        to: user.email,
        subject: `[FinHub] ${title}`,
        html: emailHtml || layout({ title, intro: body, cta: link ? { label: 'Abrir no FinHub', url: `${config.appUrl}/${link}` } : null }),
      });
    }
  }
}
