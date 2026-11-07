import 'dotenv/config';
import path from 'node:path';
import crypto from 'node:crypto';

const env = process.env;
// URL pública: APP_URL ou detectada automaticamente em Render / Railway
const appUrl = (
  env.APP_URL ||
  env.RENDER_EXTERNAL_URL ||
  (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '') ||
  `http://localhost:${env.PORT || 3000}`
).replace(/\/$/, '');

if (!env.JWT_SECRET) {
  console.warn('[config] JWT_SECRET não definido — usando segredo temporário (sessões caem a cada reinício). Defina no .env em produção.');
}

export const config = {
  port: Number(env.PORT || 3000),
  appUrl,
  isProd: env.NODE_ENV === 'production',
  jwtSecret: env.JWT_SECRET || crypto.randomBytes(32).toString('hex'),
  dataDir: path.resolve(env.DATA_DIR || './data'),
  timezone: env.TZ_NAME || 'America/Sao_Paulo',
  // Brasil não tem horário de verão desde 2019: offset fixo para fechar meses corretamente
  tzOffset: env.TZ_OFFSET || '-03:00',
  maxUploadMb: Number(env.MAX_UPLOAD_MB || 25),
  // Em site público: só este e-mail pode criar a conta de administrador no primeiro acesso
  adminEmail: (env.ADMIN_EMAIL || '').trim().toLowerCase(),

  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT || 587),
    secure: env.SMTP_SECURE === 'true',
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.MAIL_FROM || 'FinHub <no-reply@finhub.local>',
  },
  // Envio por API HTTP (não depende de portas SMTP — útil em hospedagens gratuitas que bloqueiam SMTP)
  brevo: {
    apiKey: env.BREVO_API_KEY || '',
    url: env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email',
  },

  storage: {
    driver: (env.STORAGE_DRIVER || 'local').toLowerCase(), // local | s3 | azure
    s3: {
      bucket: env.S3_BUCKET,
      region: env.S3_REGION || 'us-east-1',
      endpoint: env.S3_ENDPOINT || undefined, // R2, MinIO, Backblaze, Wasabi...
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
    },
    azure: {
      connectionString: env.AZURE_STORAGE_CONNECTION_STRING,
      container: env.AZURE_STORAGE_CONTAINER || 'finhub',
    },
  },
  backupEnabled: env.BACKUP_ENABLED ? env.BACKUP_ENABLED === 'true' : (env.STORAGE_DRIVER || 'local') !== 'local',

  microsoft: {
    clientId: env.MS_CLIENT_ID || '',
    clientSecret: env.MS_CLIENT_SECRET || '',
    tenant: env.MS_TENANT_ID || 'common',
    redirectUri: `${appUrl}/api/integrations/microsoft/callback`,
    syncCron: env.MS_SYNC_CRON || '*/15 * * * *',
  },

  reminders: {
    // Dias úteis, entre estas horas (fuso TZ_NAME). Cada tarefa atrasada é lembrada a cada OVERDUE_REMINDER_HOURS.
    startHour: Number(env.REMINDER_START_HOUR || 8),
    endHour: Number(env.REMINDER_END_HOUR || 18),
    overdueEveryHours: Number(env.OVERDUE_REMINDER_HOURS || 24),
    dueSoonHours: Number(env.DUE_SOON_HOURS || 24),
  },
  // Relatório mensal: dia 1, a partir desta hora (referente ao mês anterior)
  monthlyReport: { hour: Number(env.MONTHLY_REPORT_HOUR || 8) },

  webrtc: {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      ...(env.TURN_URLS
        ? [{ urls: env.TURN_URLS.split(','), username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL }]
        : []),
    ],
  },
};

export const STATUSES = [
  { id: 'todo', label: 'A Fazer' },
  { id: 'doing', label: 'Em Andamento' },
  { id: 'waiting', label: 'Aguardando Terceiros' },
  { id: 'done', label: 'Concluído' },
];
export const STATUS_IDS = STATUSES.map((s) => s.id);
export const PRIORITIES = ['baixa', 'media', 'alta', 'urgente'];
export const RECURRENCES = ['none', 'daily', 'weekly', 'monthly'];
export const CATEGORIES = [
  'Contas a Pagar',
  'Contas a Receber',
  'Conciliação Bancária',
  'Fechamento Contábil',
  'Fiscal / Tributário',
  'Orçamento / Forecast',
  'Relatórios Gerenciais',
  'Tesouraria',
  'Auditoria / Compliance',
  'Outros',
];
