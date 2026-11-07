import { state, api } from '../api.js';
import { $, esc, avatar, toast } from '../util.js';

/** Recorta o centro da imagem em quadrado e reduz para `size` px (JPEG), no navegador */
async function squareResize(file, size) {
  const img = await createImageBitmap(file);
  const side = Math.min(img.width, img.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Falha ao processar a imagem'))), 'image/jpeg', 0.88));
}

export async function renderProfile(container) {
  const u = state.user;
  container.innerHTML = `
  <div class="grid" style="grid-template-columns:1fr 1fr;max-width:900px;align-items:start">
    <div class="card card-pad">
      <div class="row" style="margin-bottom:16px;gap:16px"><span id="pf-avatar">${avatar(u, 88)}</span>
        <div><h3 style="margin:0">${esc(u.name)}</h3><div class="muted">${esc(u.email)}</div>
          <div class="row" style="margin-top:10px">
            <button class="btn sm primary" type="button" id="photo-btn">${u.avatar_file_id ? 'Trocar foto' : 'Adicionar foto'}</button>
            ${u.avatar_file_id ? '<button class="btn sm danger" type="button" id="photo-rm">Remover</button>' : ''}
            <input type="file" id="photo-input" accept="image/jpeg,image/png,image/webp" hidden>
          </div><div class="muted small" style="margin-top:4px">JPG, PNG ou WEBP. A imagem é recortada em quadrado.</div></div></div>
      <form class="form" id="pf">
        <label class="field">Nome<input class="input" name="name" value="${esc(u.name)}" required></label>
        <label class="row"><input type="checkbox" name="notify_email" ${u.notify_email ? 'checked' : ''}> Receber notificações por e-mail (atribuições, comentários, reaberturas)</label>
        <p class="muted small" style="margin:0">Lembretes de tarefas em atraso e o resumo mensal de indicadores são sempre enviados.</p>
        <button class="btn primary" type="submit">Salvar</button>
      </form>
    </div>
    <div class="card card-pad">
      <h3>Alterar senha</h3>
      <form class="form" id="pw">
        <label class="field">Senha atual<input class="input" type="password" name="current" required autocomplete="current-password"></label>
        <label class="field">Nova senha<input class="input" type="password" name="password" required autocomplete="new-password"><span class="muted small">Mínimo de 8 caracteres, com letras e números.</span></label>
        <label class="field">Confirmar<input class="input" type="password" name="confirm" required autocomplete="new-password"></label>
        <button class="btn primary" type="submit">Alterar senha</button>
      </form>
    </div>
  </div>`;
  const input = $('#photo-input', container);
  $('#photo-btn', container).onclick = () => input.click();
  input.onchange = async () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    try {
      const blob = await squareResize(file, 320);
      const fd = new FormData();
      fd.append('avatar', blob, 'foto.jpg');
      const { user } = await api('/users/me/avatar', { method: 'POST', form: fd });
      Object.assign(state.user, user);
      toast('Foto atualizada', 'success');
      renderProfile(container);
    } catch (e) { toast(e.message || 'Não foi possível ler a imagem.', 'error'); }
  };
  $('#photo-rm', container) && ($('#photo-rm', container).onclick = async () => {
    const { user } = await api('/users/me/avatar', { method: 'DELETE' });
    Object.assign(state.user, user);
    toast('Foto removida');
    renderProfile(container);
  });

  $('#pf', container).onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const { user } = await api('/users/me', { method: 'PATCH', body: { name: f.name.value, notify_email: f.notify_email.checked } });
      state.user = user;
      toast('Perfil atualizado', 'success');
    } catch (ex) { toast(ex.message, 'error'); }
  };
  $('#pw', container).onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    if (d.password !== d.confirm) return toast('As senhas não conferem', 'error');
    try { await api('/auth/change-password', { method: 'POST', body: d }); toast('Senha alterada', 'success'); e.target.reset(); } catch (ex) { toast(ex.message, 'error'); }
  };
}
