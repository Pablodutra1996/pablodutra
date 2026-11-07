import { Router } from 'express';
import { q, now } from '../db.js';
import { fail } from '../util.js';
import { emitAll } from '../realtime.js';

const r = Router();

r.get('/', (req, res) => {
  const boards = q.all(`
    SELECT b.*,
      (SELECT COUNT(*) FROM tasks t WHERE t.board_id=b.id) total,
      (SELECT COUNT(*) FROM tasks t WHERE t.board_id=b.id AND t.status='done') done,
      (SELECT COUNT(*) FROM tasks t WHERE t.board_id=b.id AND t.status!='done' AND t.due_date < ?) overdue
    FROM boards b WHERE b.archived=0 ORDER BY b.created_at`, now());
  res.json({ boards });
});

r.post('/', (req, res) => {
  const { name, description, color } = req.body || {};
  if (!name?.trim()) fail(400, 'Informe o nome do quadro.');
  const info = q.run('INSERT INTO boards (name, description, color, created_by, created_at) VALUES (?,?,?,?,?)',
    name.trim(), description || '', color || '#4f46e5', req.user.id, now());
  const board = q.get('SELECT * FROM boards WHERE id=?', info.lastInsertRowid);
  emitAll('boards:changed', {});
  res.json({ board });
});

r.patch('/:id', (req, res) => {
  const board = q.get('SELECT * FROM boards WHERE id=?', req.params.id);
  if (!board) fail(404, 'Quadro não encontrado.');
  const { name, description, color, archived } = req.body || {};
  if (archived && req.user.role !== 'admin' && board.created_by !== req.user.id) fail(403, 'Apenas o criador ou um administrador pode arquivar.');
  q.run('UPDATE boards SET name=COALESCE(?,name), description=COALESCE(?,description), color=COALESCE(?,color), archived=COALESCE(?,archived) WHERE id=?',
    name?.trim() || null, description ?? null, color ?? null, archived === undefined ? null : archived ? 1 : 0, board.id);
  emitAll('boards:changed', {});
  res.json({ board: q.get('SELECT * FROM boards WHERE id=?', board.id) });
});

export default r;
