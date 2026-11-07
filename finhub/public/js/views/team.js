import { state, api } from '../api.js';
import { $, $$, esc, avatar, icon, toast, fmtDateTime, relTime } from '../util.js';

export async function renderTeam(container) {
  async function draw() {
    const [{ users, online }, { invites }, sys] = await Promise.all([api('/users'), api('/users/invites'), api('/dashboard/system')]);
    state.users = users;
    state.online = new Set(online);
    container.innerHTML = `
    <div class="grid" style="grid-template-columns:1fr 1.6fr;align-items:start">
      <div class="grid">
        <div class="card card-pad">
          <h3>${icon('mail', 18)} Convidar pessoa</h3>
          <p class="muted" style="margin-top:0">A pessoa recebe um e-mail com o link para criar o próprio login e senha (válido por 7 dias).</p>
          <form class="form" id="invite-form">
            <label class="field">E-mail<input class="input" type="email" name="email" required placeholder="nome@empresa.com.br"></label>
            <label class="field">Perfil<select class="input" name="role"><option value="member">Membro</option><option value="admin">Administrador</option></select></label>
            <button class="btn primary" type="submit">Enviar convite</button>
            <div id="invite-result"></div>
          </form>
        </div>
        <div class="card card-pad">
          <h3>${icon('shield', 18)} Sistema</h3>
          <div class="small" style="line-height:1.8">E-mail: ${sys.mail.smtpConfigured ? `<span class="tag ok">${esc(sys.mail.provider)} configurado</span>`
            : `<span class="tag soon">Modo teste</span><br><span class="muted">SMTP não configurado: e-mails são gravados em <code>${esc(sys.mail.outbox)}</code>.</span>`}</div>
          <div class="row wrap" style="margin-top:12px">
            <button class="btn sm" id="run-reminders">${icon('bell', 14)} Disparar lembretes agora</button>
            <button class="btn sm" id="send-me">${icon('mail', 14)} Me enviar o resumo do mês</button>
            <button class="btn sm" id="backup">${icon('import', 14)} Backup do banco</button>
          </div>
          <div class="section-title">Últimos e-mails</div>
          <div class="small" style="max-height:220px;overflow:auto">${sys.emails.map((e) => `<div style="padding:4px 0;border-bottom:1px solid #f0f1f5">
            <span class="tag ${e.status === 'error' ? 'late' : 'ok'}">${esc(e.status)}</span> ${esc(e.subject)}<div class="muted">${esc(e.recipient)} · ${relTime(e.created_at)}${e.error ? ` · ${esc(e.error)}` : ''}</div></div>`).join('') || '<span class="muted">Nenhum e-mail enviado.</span>'}</div>
        </div>
      </div>
      <div class="grid">
        <div class="card" style="overflow:auto"><div class="card-pad" style="padding-bottom:4px"><h3>Equipe (${users.length})</h3></div>
          <table class="tbl"><thead><tr><th>Pessoa</th><th>Perfil</th><th>Status</th><th>Último acesso</th></tr></thead><tbody>
          ${users.map((u) => `<tr><td><span class="row">${avatar(u, 30, state.online.has(u.id))}<span><b>${esc(u.name)}</b><div class="muted small">${esc(u.email)}</div></span></span></td>
            <td><select class="input" data-role="${u.id}" ${u.id === state.user.id ? 'disabled' : ''} style="width:auto"><option value="member" ${u.role === 'member' ? 'selected' : ''}>Membro</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Administrador</option></select></td>
            <td><select class="input" data-status="${u.id}" ${u.id === state.user.id ? 'disabled' : ''} style="width:auto"><option value="active" ${u.status === 'active' ? 'selected' : ''}>Ativo</option><option value="disabled" ${u.status === 'disabled' ? 'selected' : ''}>Desativado</option></select></td>
            <td class="small muted">${state.online.has(u.id) ? '<span style="color:var(--ok)">● Online</span>' : u.last_seen_at ? relTime(u.last_seen_at) : 'Nunca'}</td></tr>`).join('')}
          </tbody></table></div>
        <div class="card" style="overflow:auto"><div class="card-pad" style="padding-bottom:4px"><h3>Convites pendentes (${invites.length})</h3></div>
          ${invites.length ? `<table class="tbl"><thead><tr><th>E-mail</th><th>Perfil</th><th>Expira em</th><th></th></tr></thead><tbody>
          ${invites.map((i) => `<tr><td>${esc(i.email)}</td><td>${i.role === 'admin' ? 'Administrador' : 'Membro'}</td>
            <td class="small">${fmtDateTime(i.expires_at)}${i.expires_at < new Date().toISOString() ? ' <span class="tag late">expirado</span>' : ''}</td>
            <td><div class="row" style="justify-content:flex-end"><button class="btn sm" data-copy="${esc(i.token)}">Copiar link</button><button class="btn sm" data-resend="${i.id}">Reenviar</button>
              <button class="btn sm danger" data-cancel="${i.id}">Cancelar</button></div></td></tr>`).join('')}</tbody></table>`
          : '<div class="empty">Nenhum convite pendente.</div>'}</div>
      </div>
    </div>`;
    bind();
  }

  function bind() {
    $('#invite-form', container).onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await api('/users/invite', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
        toast(r.sent ? 'Convite enviado por e-mail!' : 'Convite criado, mas o e-mail falhou — copie o link.', r.sent ? 'success' : 'error');
        await draw();
        $('#invite-result', container).innerHTML = `<div class="evidence-box small">Link do convite (caso queira enviar por outro meio):<br><code style="word-break:break-all">${esc(r.link)}</code></div>`;
      } catch (ex) { toast(ex.message, 'error'); }
    };
    $$('[data-role]', container).forEach((s) => (s.onchange = () => api(`/users/${s.dataset.role}`, { method: 'PATCH', body: { role: s.value } }).then(() => toast('Perfil atualizado', 'success')).catch((e) => toast(e.message, 'error'))));
    $$('[data-status]', container).forEach((s) => (s.onchange = () => api(`/users/${s.dataset.status}`, { method: 'PATCH', body: { status: s.value } }).then(() => toast('Status atualizado', 'success')).catch((e) => toast(e.message, 'error'))));
    $$('[data-copy]', container).forEach((b) => (b.onclick = () => { navigator.clipboard.writeText(`${location.origin}/#/convite/${b.dataset.copy}`); toast('Link copiado'); }));
    $$('[data-resend]', container).forEach((b) => (b.onclick = async () => { const r = await api(`/users/invites/${b.dataset.resend}/resend`, { method: 'POST' }); toast(r.sent ? 'Convite reenviado' : 'Falha no envio do e-mail', r.sent ? 'success' : 'error'); draw(); }));
    $$('[data-cancel]', container).forEach((b) => (b.onclick = async () => { await api(`/users/invites/${b.dataset.cancel}`, { method: 'DELETE' }); draw(); }));
    $('#run-reminders', container).onclick = async () => { const r = await api('/dashboard/run-reminders', { method: 'POST' }); toast(`Lembretes: ${r.overdue} atrasada(s), ${r.soon} vencendo — ${r.users} pessoa(s) notificada(s).`, 'success'); draw(); };
    $('#send-me', container).onclick = async () => { const d = new Date(); const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; await api('/dashboard/send-report', { method: 'POST', body: { month, only_me: true } }); toast('Resumo enviado para seu e-mail', 'success'); draw(); };
    $('#backup', container).onclick = async () => { try { const r = await api('/dashboard/backup', { method: 'POST' }); toast(`Backup salvo: ${r.key}`, 'success'); } catch (e) { toast(e.message, 'error'); } };
  }
  await draw();
}
