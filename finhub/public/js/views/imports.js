import { state, api } from '../api.js';
import { $, $$, esc, icon, toast, fmtDateTime, confirmDialog } from '../util.js';

export async function renderImports(container, _p, query) {
  if (query.ms === 'ok') toast('Microsoft To Do conectado! A primeira sincronização já começou.', 'success');
  if (query.ms === 'erro') toast(`Erro ao conectar com a Microsoft: ${query.msg || ''}`, 'error');

  async function draw() {
    const [{ microsoft: ms }, { boards }] = await Promise.all([api('/integrations'), api('/boards')]);
    state.boards = boards;
    const boardOpts = (sel) => boards.map((b) => `<option value="${b.id}" ${b.id === sel ? 'selected' : ''}>${esc(b.name)}</option>`).join('');

    container.innerHTML = `
    <div class="grid" style="grid-template-columns:1fr 1fr;align-items:start">
      <div class="card card-pad">
        <div class="row" style="margin-bottom:10px">
          <svg width="28" height="28" viewBox="0 0 24 24"><rect x="1" y="1" width="10" height="10" fill="#f25022"/><rect x="13" y="1" width="10" height="10" fill="#7fba00"/><rect x="1" y="13" width="10" height="10" fill="#00a4ef"/><rect x="13" y="13" width="10" height="10" fill="#ffb900"/></svg>
          <h3 style="margin:0">Microsoft To Do</h3><div class="spacer"></div>
          ${ms.connected ? '<span class="tag ok">Conectado</span>' : '<span class="tag">Não conectado</span>'}
        </div>
        <p class="muted" style="margin-top:0">Importa automaticamente suas tarefas do To Do (inclusive as sinalizadas no Outlook) a cada 15 minutos.
          Tarefas importadas ficam atribuídas a você. Tarefas concluídas no To Do não são importadas como concluídas — a conclusão no FinHub sempre exige evidência.</p>
        ${!ms.enabled ? `<div class="rule-box">A integração ainda não foi configurada no servidor. O administrador precisa registrar um aplicativo no Azure (Microsoft Entra ID)
            e preencher <code>MS_CLIENT_ID</code> e <code>MS_CLIENT_SECRET</code> no arquivo <code>.env</code>.<br><br>
            URI de redirecionamento a cadastrar: <code>${esc(ms.redirectUri)}</code><br>Permissões delegadas: <code>Tasks.Read</code>, <code>User.Read</code>, <code>offline_access</code>.</div>`
        : ms.connected ? `
          <div class="small" style="line-height:1.8;margin-bottom:12px">Conta: <b>${esc(ms.account || '')}</b><br>
            Última sincronização: ${ms.last_sync_at ? fmtDateTime(ms.last_sync_at) : '—'} ${ms.last_sync_status ? `· <span class="muted">${esc(ms.last_sync_status)}</span>` : ''}</div>
          <div class="form">
            <label class="field">Quadro de destino<select class="input" id="ms-board"><option value="">Criar quadro "Importadas · Microsoft To Do"</option>${boardOpts(ms.settings?.board_id)}</select></label>
            <label class="row"><input type="checkbox" id="ms-auto" ${ms.settings?.auto_sync !== false ? 'checked' : ''}> Sincronizar automaticamente a cada 15 minutos</label>
            <div class="field">Listas a importar <span class="muted small">(nenhuma marcada = todas)</span><div id="ms-lists" class="muted small">Carregando listas…</div></div>
            <div class="row"><button class="btn primary" id="ms-sync">${icon('refresh', 16)} Sincronizar agora</button><div class="spacer"></div>
              <button class="btn danger" id="ms-disconnect">Desconectar</button></div>
          </div>`
        : `<button class="btn primary" id="ms-connect">Conectar com conta Microsoft</button>`}
      </div>

      <div class="card card-pad">
        <h3>${icon('file', 18)} Importar de planilha ou outra plataforma</h3>
        <p class="muted" style="margin-top:0">Envie um arquivo exportado de outra ferramenta:</p>
        <ul class="small" style="line-height:1.8;padding-left:18px;margin-top:0">
          <li><b>Trello:</b> menu do quadro › Imprimir, exportar e compartilhar › Exportar como <b>JSON</b></li>
          <li><b>Asana:</b> projeto › Exportar › <b>CSV</b></li>
          <li><b>Monday.com:</b> exportar quadro para Excel e salvar como <b>CSV</b></li>
          <li><b>Planner / Excel / ClickUp:</b> CSV com colunas como <i>Título, Descrição, Vencimento, Responsável (e-mail ou nome), Prioridade, Categoria, Status</i></li>
        </ul>
        <form class="form" id="file-form">
          <label class="field">Quadro de destino<select class="input" name="board_id" required>${boardOpts()}</select></label>
          <label class="field">Arquivo (.csv ou .json)<input class="input" type="file" name="file" accept=".csv,.json,text/csv,application/json" required></label>
          <button class="btn primary" type="submit">${icon('import', 16)} Importar</button>
          <div id="import-result"></div>
        </form>
        <p class="muted small">Tarefas já concluídas no arquivo são ignoradas. Datas no formato dd/mm/aaaa ou aaaa-mm-dd. Separador vírgula ou ponto-e-vírgula.</p>
      </div>
    </div>`;

    $('#ms-connect', container) && ($('#ms-connect', container).onclick = async () => {
      try { const { url } = await api('/integrations/microsoft/connect'); location.href = url; } catch (e) { toast(e.message, 'error'); }
    });
    if (ms.connected) {
      const save = (body) => api('/integrations/microsoft/settings', { method: 'PATCH', body }).then(() => toast('Preferências salvas', 'success')).catch((e) => toast(e.message, 'error'));
      $('#ms-board', container).onchange = (e) => save({ board_id: e.target.value || null });
      $('#ms-auto', container).onchange = (e) => save({ auto_sync: e.target.checked });
      $('#ms-sync', container).onclick = async (e) => {
        e.target.disabled = true;
        try {
          const { stats } = await api('/integrations/microsoft/sync', { method: 'POST' });
          toast(`Sincronizado: ${stats.created} novas, ${stats.updated} atualizadas.`, 'success');
          draw();
        } catch (ex) { toast(ex.message, 'error'); e.target.disabled = false; }
      };
      $('#ms-disconnect', container).onclick = async () => {
        if (!(await confirmDialog('Desconectar o Microsoft To Do? As tarefas já importadas continuam no FinHub.', { ok: 'Desconectar', danger: true }))) return;
        await api('/integrations/microsoft', { method: 'DELETE' });
        draw();
      };
      api('/integrations/microsoft/lists').then(({ lists }) => {
        const selected = new Set(ms.settings?.lists || []);
        const el = $('#ms-lists', container);
        if (!el) return;
        el.innerHTML = lists.map((l) => `<label class="row" style="color:var(--text);font-weight:400"><input type="checkbox" value="${esc(l.id)}" ${selected.has(l.id) ? 'checked' : ''}> ${esc(l.name)}</label>`).join('') || 'Nenhuma lista encontrada.';
        $$('input', el).forEach((cb) => (cb.onchange = () => save({ lists: $$('input:checked', el).map((x) => x.value) })));
      }).catch((e) => { const el = $('#ms-lists', container); if (el) el.textContent = e.message; });
    }

    $('#file-form', container).onsubmit = async (e) => {
      e.preventDefault();
      const btn = $('button[type=submit]', e.target);
      btn.disabled = true;
      try {
        const { stats } = await api('/integrations/file', { method: 'POST', form: new FormData(e.target) });
        $('#import-result', container).innerHTML = `<div class="evidence-box">✔ <b>${stats.created}</b> tarefas criadas · ${stats.updated} atualizadas · ${stats.skipped} ignoradas (já concluídas)
          ${stats.errors.length ? `<div class="small" style="color:var(--bad);margin-top:6px">${stats.errors.slice(0, 5).map(esc).join('<br>')}</div>` : ''}</div>`;
        e.target.reset();
      } catch (ex) {
        $('#import-result', container).innerHTML = `<div class="error-box">${esc(ex.message)}</div>`;
      } finally { btn.disabled = false; }
    };
  }
  await draw();
}
