import { api } from '../api.js';
import { $, esc, toast } from '../util.js';
import { afterLogin } from '../app.js';

const hero = `
  <div class="auth-hero">
    <div class="logo"><span class="logo-mark">F</span> FinHub</div>
    <div>
      <h1>Gestão de tarefas, comunicação e indicadores da área financeira em um só lugar.</h1>
      <ul>
        <li>✔ Quadros Kanban para rotinas de fechamento, contas a pagar/receber, fiscal…</li>
        <li>✔ Conclusão somente com evidência anexada pelo responsável</li>
        <li>✔ Chat e videochamadas da equipe</li>
        <li>✔ Lembretes por e-mail e relatório mensal de indicadores</li>
        <li>✔ Importação automática do Microsoft To Do</li>
      </ul>
    </div>
    <div class="small" style="opacity:.7">© FinHub</div>
  </div>`;

function shell(app, inner) {
  app.innerHTML = `<div class="auth-wrap">${hero}<div class="auth-panel"><div class="auth-card">${inner}</div></div></div>`;
}

function bindForm(app, handler) {
  const form = $('form', app);
  const err = $('.error-box', app);
  form.onsubmit = async (e) => {
    e.preventDefault();
    err.classList.add('hidden');
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try {
      await handler(Object.fromEntries(new FormData(form)));
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  };
}

const pwHint = '<span class="muted small">Mínimo de 8 caracteres, com letras e números.</span>';

export async function renderAuth(app, view, token) {
  if (view === 'login') {
    const { needsSetup } = await api('/auth/setup-status');
    if (needsSetup) return (location.hash = '#/setup');
    shell(app, `
      <h2>Entrar</h2><p class="muted" style="margin:0 0 22px">Acesse com seu e-mail corporativo.</p>
      <form class="form">
        <label class="field">E-mail<input class="input" name="email" type="email" required autocomplete="username" autofocus></label>
        <label class="field">Senha<input class="input" name="password" type="password" required autocomplete="current-password"></label>
        <div class="error-box hidden"></div>
        <button class="btn primary" type="submit">Entrar</button>
        <a href="#/esqueci" class="small" style="text-align:center">Esqueci minha senha</a>
      </form>
      <p class="muted small" style="margin-top:28px">Não tem acesso? Peça um convite ao administrador da área.</p>`);
    bindForm(app, async (d) => { await api('/auth/login', { method: 'POST', body: d }); await afterLogin(); });
  }

  if (view === 'setup') {
    shell(app, `
      <h2>Configuração inicial</h2><p class="muted" style="margin:0 0 22px">Crie a conta de administrador. Depois você convida sua equipe por e-mail.</p>
      <form class="form">
        <label class="field">Seu nome<input class="input" name="name" required autofocus></label>
        <label class="field">E-mail<input class="input" name="email" type="email" required></label>
        <label class="field">Senha<input class="input" name="password" type="password" required autocomplete="new-password">${pwHint}</label>
        <div class="error-box hidden"></div>
        <button class="btn primary" type="submit">Criar conta e começar</button>
      </form>`);
    bindForm(app, async (d) => { await api('/auth/setup', { method: 'POST', body: d }); await afterLogin(); });
  }

  if (view === 'convite') {
    let email = '';
    try {
      ({ email } = await api(`/auth/invite/${token}`));
    } catch (e) {
      return shell(app, `<h2>Convite indisponível</h2><p class="error-box">${esc(e.message)}</p><a class="btn" href="#/login">Ir para o login</a>`);
    }
    shell(app, `
      <h2>Bem-vindo(a) ao FinHub</h2><p class="muted" style="margin:0 0 22px">Crie seu acesso para <b>${esc(email)}</b>.</p>
      <form class="form">
        <label class="field">Nome completo<input class="input" name="name" required autofocus></label>
        <label class="field">Crie uma senha<input class="input" name="password" type="password" required autocomplete="new-password">${pwHint}</label>
        <label class="field">Confirme a senha<input class="input" name="confirm" type="password" required autocomplete="new-password"></label>
        <div class="error-box hidden"></div>
        <button class="btn primary" type="submit">Criar acesso</button>
      </form>`);
    bindForm(app, async (d) => {
      if (d.password !== d.confirm) throw new Error('As senhas não conferem.');
      await api('/auth/accept-invite', { method: 'POST', body: { token, name: d.name, password: d.password } });
      await afterLogin();
    });
  }

  if (view === 'esqueci') {
    shell(app, `
      <h2>Recuperar senha</h2><p class="muted" style="margin:0 0 22px">Enviaremos um link de redefinição para seu e-mail.</p>
      <form class="form">
        <label class="field">E-mail<input class="input" name="email" type="email" required autofocus></label>
        <div class="error-box hidden"></div>
        <button class="btn primary" type="submit">Enviar link</button>
        <a href="#/login" class="small" style="text-align:center">Voltar ao login</a>
      </form>`);
    bindForm(app, async (d) => {
      await api('/auth/forgot', { method: 'POST', body: d });
      toast('Se o e-mail estiver cadastrado, você receberá o link em instantes.', 'success');
      location.hash = '#/login';
    });
  }

  if (view === 'redefinir') {
    shell(app, `
      <h2>Nova senha</h2>
      <form class="form" style="margin-top:18px">
        <label class="field">Nova senha<input class="input" name="password" type="password" required autofocus autocomplete="new-password">${pwHint}</label>
        <label class="field">Confirme<input class="input" name="confirm" type="password" required autocomplete="new-password"></label>
        <div class="error-box hidden"></div>
        <button class="btn primary" type="submit">Salvar nova senha</button>
      </form>`);
    bindForm(app, async (d) => {
      if (d.password !== d.confirm) throw new Error('As senhas não conferem.');
      await api('/auth/reset', { method: 'POST', body: { token, password: d.password } });
      toast('Senha alterada. Faça login.', 'success');
      location.hash = '#/login';
    });
  }
}
