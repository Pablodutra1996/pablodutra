import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import { config } from './config.js';
import './db.js';
import { requireAuth } from './auth.js';
import { initRealtime } from './realtime.js';
import { startJobs } from './jobs.js';
import { getStorage } from './storage.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import boardRoutes from './routes/boards.js';
import taskRoutes from './routes/tasks.js';
import chatRoutes from './routes/chat.js';
import miscRoutes from './routes/misc.js';
import importRoutes, { callbackRouter } from './routes/imports.js';
import dashboardRoutes from './routes/dashboard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
  next();
});

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use('/api/integrations', callbackRouter);
app.use('/api/users', requireAuth, userRoutes);
app.use('/api/boards', requireAuth, boardRoutes);
app.use('/api/tasks', requireAuth, taskRoutes);
app.use('/api/chat', requireAuth, chatRoutes);
app.use('/api/integrations', requireAuth, importRoutes);
app.use('/api/dashboard', requireAuth, dashboardRoutes);
app.use('/api', requireAuth, miscRoutes);
app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada' }));

app.use(express.static(publicDir, { index: 'index.html', maxAge: config.isProd ? '1h' : 0 }));
// Bibliotecas de frontend servidas localmente (não depende de CDN externo / proxy corporativo)
app.get('/vendor/chart.umd.js', (req, res) => res.sendFile(path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist', 'chart.umd.js')));
app.use((req, res, next) => (req.method === 'GET' ? res.sendFile(path.join(publicDir, 'index.html')) : next()));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `Arquivo maior que ${config.maxUploadMb} MB.` : `Erro no upload: ${err.message}`;
    return res.status(400).json({ error: msg });
  }
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 && config.isProd ? 'Erro interno' : err.message });
});

const server = http.createServer(app);
initRealtime(server);
await getStorage();
startJobs();
server.listen(config.port, () => console.log(`FinHub rodando em ${config.appUrl} (porta ${config.port})`));
