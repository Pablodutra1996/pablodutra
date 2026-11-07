import { Router } from 'express';
import { q } from '../db.js';
import { config } from '../config.js';
import { fail } from '../util.js';
import { upload } from '../services.js';
import {
  microsoftEnabled, microsoftAuthUrl, microsoftCallback, microsoftLists, syncMicrosoft, getMicrosoftIntegration, importFile,
} from '../integrations.js';

export const callbackRouter = Router();
// Callback do OAuth Microsoft (rota pública; o "state" assinado identifica o usuário)
callbackRouter.get('/microsoft/callback', async (req, res) => {
  if (req.query.error) return res.redirect(`/#/importacoes?ms=erro&msg=${encodeURIComponent(req.query.error_description || req.query.error)}`);
  try {
    const uid = await microsoftCallback(String(req.query.code), String(req.query.state));
    const integ = getMicrosoftIntegration(uid);
    syncMicrosoft(integ).catch((e) => console.error('[ms-todo] primeira sync:', e.message));
    res.redirect('/#/importacoes?ms=ok');
  } catch (err) {
    res.redirect(`/#/importacoes?ms=erro&msg=${encodeURIComponent(err.message)}`);
  }
});

const r = Router();

r.get('/', (req, res) => {
  const ms = getMicrosoftIntegration(req.user.id);
  res.json({
    microsoft: {
      enabled: microsoftEnabled(),
      redirectUri: config.microsoft.redirectUri,
      connected: !!ms,
      account: ms?.account_email,
      settings: ms ? JSON.parse(ms.settings || '{}') : null,
      last_sync_at: ms?.last_sync_at,
      last_sync_status: ms?.last_sync_status,
    },
  });
});

r.get('/microsoft/connect', (req, res) => {
  if (!microsoftEnabled()) fail(400, 'Integração Microsoft não configurada (MS_CLIENT_ID / MS_CLIENT_SECRET).');
  res.json({ url: microsoftAuthUrl(req.user.id) });
});

r.get('/microsoft/lists', async (req, res) => {
  try {
    res.json({ lists: await microsoftLists(req.user.id) });
  } catch (err) {
    fail(400, err.message);
  }
});

r.patch('/microsoft/settings', (req, res) => {
  const integ = getMicrosoftIntegration(req.user.id);
  if (!integ) fail(404, 'Microsoft To Do não conectado.');
  const current = JSON.parse(integ.settings || '{}');
  const { lists, board_id, auto_sync } = req.body || {};
  const next = {
    ...current,
    ...(Array.isArray(lists) ? { lists } : {}),
    ...(board_id !== undefined ? { board_id: board_id ? Number(board_id) : null } : {}),
    ...(auto_sync !== undefined ? { auto_sync: !!auto_sync } : {}),
  };
  q.run('UPDATE integrations SET settings=? WHERE id=?', JSON.stringify(next), integ.id);
  res.json({ settings: next });
});

r.post('/microsoft/sync', async (req, res) => {
  const integ = getMicrosoftIntegration(req.user.id);
  if (!integ) fail(404, 'Microsoft To Do não conectado.');
  try {
    res.json({ stats: await syncMicrosoft(integ) });
  } catch (err) {
    fail(502, `Falha ao sincronizar: ${err.message}`);
  }
});

r.delete('/microsoft', (req, res) => {
  q.run(`DELETE FROM integrations WHERE user_id=? AND provider='microsoft_todo'`, req.user.id);
  res.json({ ok: true });
});

r.post('/file', upload.single('file'), (req, res) => {
  if (!req.file) fail(400, 'Envie um arquivo CSV ou JSON.');
  const boardId = Number(req.body?.board_id);
  if (!q.get('SELECT id FROM boards WHERE id=? AND archived=0', boardId)) fail(400, 'Selecione o quadro de destino.');
  try {
    res.json({ stats: importFile({ buffer: req.file.buffer, filename: req.file.originalname, boardId, user: req.user }) });
  } catch (err) {
    fail(400, `Não foi possível importar: ${err.message}`);
  }
});

export default r;
