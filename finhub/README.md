# FinHub — Gestão de tarefas, chat e indicadores da área financeira

Plataforma web para uma equipe financeira pequena (pensada para 3 pessoas, aguenta bem mais) que junta:

| Necessidade | Como o FinHub atende |
|---|---|
| Gerenciar tarefas (estilo Trello/Asana/Monday) | Quadros Kanban com arrastar e soltar, visão em lista, filtros, prioridades, categorias financeiras, prazos, anexos, comentários, histórico e tarefas **recorrentes** (diária/semanal/mensal — ex.: fechamento mensal) |
| Chat estilo Teams | Canais (#geral + canais criados), mensagens diretas, anexos e imagens, indicador de "digitando", presença online, contador de não lidas |
| Videochamada | Vídeo ou só áudio, **liga/desliga câmera e microfone** durante a chamada, compartilhamento de tela, toque de chamada para os colegas, minimizar e continuar usando a plataforma |
| Importar tarefas de outras plataformas | **Microsoft To Do** (login Microsoft, sincronização automática a cada 15 min, escolha de listas) + arquivos do **Trello** (JSON), **Asana / Monday / Planner / Excel / ClickUp** (CSV) |
| Lembrete por e-mail até a conclusão | E-mail diário (dias úteis) para o responsável enquanto a tarefa estiver atrasada, e aviso 24h antes do vencimento. Um e-mail por pessoa, listando todas as pendências |
| Conclusão só com evidência | A tarefa **só pode ir para "Concluído" pelo responsável**, com descrição + arquivo de evidência. Evidências não podem ser apagadas (trilha de auditoria). Quem criou a tarefa ou um admin pode **reabrir** (evidência é marcada como rejeitada e o responsável é avisado) |
| Indicadores mensais + e-mail | Dashboard na plataforma e **e-mail automático no dia 1 de cada mês** com o resumo do mês anterior (cada pessoa recebe os seus; administradores recebem também o consolidado da equipe) |
| Login, senha e convite por e-mail | Administrador convida pelo e-mail; a pessoa recebe o link e cria o próprio login e senha. Recuperação de senha por e-mail |
| Armazenamento na nuvem | Arquivos em **Azure Blob Storage** ou **AWS S3** (ou compatíveis: Cloudflare R2, Backblaze, Wasabi) + backup diário do banco para a nuvem |

## Indicadores mapeados

| Indicador | Definição |
|---|---|
| Taxa de conclusão | % das tarefas com prazo no mês que estão concluídas |
| Entregas no prazo | % das tarefas concluídas no mês entregues até o vencimento |
| Concluídas / criadas no mês | Volume (throughput) |
| Tempo médio de conclusão (lead time) | Da criação até a conclusão |
| Tempo médio de execução (cycle time) | Do início ("Em Andamento") até a conclusão |
| Tempo médio em cada etapa | Quanto tempo as tarefas ficam em A Fazer / Em Andamento / Aguardando Terceiros — mostra gargalos |
| Atraso médio | Nas entregas fora do prazo, quanto passou do vencimento |
| Em atraso | Tarefas abertas com prazo vencido no fechamento do mês |
| Reaberturas | Conclusões rejeitadas por evidência insuficiente (qualidade) |
| Quebras | Por responsável, por categoria (Contas a Pagar, Conciliação, Fiscal…), por prioridade, e tendência de 6 meses |

## Rodando localmente (5 minutos)

Requisito: **Node.js 22.5+**. Localmente o banco é SQLite (nativo do Node, nada para instalar); em produção pode ser PostgreSQL, definindo `DATABASE_URL`.

```bash
npm install
```

```bash
cp .env.example .env
```

Para testar sem configurar nada, deixe o `.env` com `STORAGE_DRIVER=local` e `SMTP_HOST=` vazio: os e-mails são gravados em `data/outbox/` para você abrir no navegador.

```bash
npm start
```

Abra http://localhost:3000 — no primeiro acesso a plataforma pede para criar a conta de **administrador**. Depois vá em **Equipe e convites** e convide seus 2 colegas.

Quer ver a plataforma já com dados? Antes do primeiro `npm start`, rode `npm run seed` (cria 3 usuários e ~6 meses de tarefas; login `admin@finhub.local` / `Financeiro123`). Apague a pasta `data/` para recomeçar do zero.

## Colocando na nuvem

O FinHub é um único serviço Node + um volume persistente (banco SQLite) + storage de arquivos na nuvem.

> 🔒 **Antes de publicar:** defina `ADMIN_EMAIL` com o seu e-mail — só ele poderá criar a conta de administrador no primeiro acesso. **Nunca rode `npm run seed` no site público** (ele cria usuários com senha conhecida).

**Custo zero e sem cartão: Render Free + Supabase** — guia em [`deploy/RENDER-SUPABASE.md`](deploy/RENDER-SUPABASE.md). Banco PostgreSQL e arquivos no Supabase, site no Render, e-mails pelo Brevo.

**Custo zero com cartão (para verificação): Oracle Cloud Always Free** — guia completo do cadastro ao site no ar em [`deploy/ORACLE.md`](deploy/ORACLE.md). A instalação no servidor é um único comando (`deploy/oracle-setup.sh`).

**Caminho mais simples: Render.com (≈ US$ 7–8/mês, HTTPS incluso)**
1. Crie uma conta no GitHub e envie esta pasta para um repositório **privado** (pelo site: *New repository › uploading an existing file*, arraste o conteúdo da pasta, exceto `node_modules` e `data`).
2. Crie uma conta em https://render.com e conecte o GitHub.
3. **New › Blueprint**, selecione o repositório. O arquivo `render.yaml` já configura tudo (Docker, disco persistente de 1 GB, segredo de sessão).
4. Preencha `ADMIN_EMAIL` (e, se já tiver, os dados de SMTP) e confirme. Em ~5 min sai um endereço como `https://finhub-xxxx.onrender.com`.
5. Acesse, crie sua conta de administrador e convide a equipe em **Equipe e convites** (sem SMTP, use **Copiar link** e mande o convite pelo Teams/WhatsApp).
6. Opcional: em *Settings › Custom Domains* use um domínio próprio (ex.: `finhub.futurum.capital`) e defina `APP_URL` com ele.

Outras opções:

**A) Servidor/VM com Docker (Azure VM, AWS Lightsail, DigitalOcean, Hostinger…) — recomendado**
1. Aponte um domínio (ex.: `finhub.suaempresa.com.br`) para o IP do servidor.
2. Copie o projeto, crie o `.env` a partir do `.env.example` (com `APP_URL=https://finhub.suaempresa.com.br`).
3. Rode:
   ```bash
   DOMAIN=finhub.suaempresa.com.br docker compose up -d
   ```
   O Caddy emite o certificado HTTPS automaticamente.

**B) PaaS (Azure App Service para containers, Render, Railway, Fly.io)**: use o `Dockerfile`, monte um disco persistente em `/app/data`, configure as variáveis do `.env` no painel e o domínio com HTTPS.

> ⚠️ **HTTPS é obrigatório em produção**: os navegadores só liberam câmera e microfone em sites HTTPS (ou `localhost`).

### Armazenamento na nuvem
- **Azure Blob Storage** (natural para quem usa Microsoft 365): crie uma *Storage Account*, copie a *connection string* (Chaves de acesso) e defina `STORAGE_DRIVER=azure`, `AZURE_STORAGE_CONNECTION_STRING` e `AZURE_STORAGE_CONTAINER`. O contêiner é criado automaticamente e é privado — os arquivos só são acessados via plataforma, com login.
- **S3 / R2 / B2**: `STORAGE_DRIVER=s3` + `S3_*`.
- Com storage em nuvem, um backup diário do banco é enviado às 02:00 para `backups/` (admins podem forçar em *Equipe e convites › Backup do banco*).

### E-mail
Configure `SMTP_*`. Com Microsoft 365 use `smtp.office365.com:587` com uma caixa que tenha **SMTP AUTH** habilitado (o admin do M365 libera em *Usuários ativos › Email › Gerenciar aplicativos de email*). Alternativas sem depender do TI: SendGrid, Amazon SES, Brevo, Mailgun. Em *Equipe e convites* há botões para disparar lembretes e enviar o resumo do mês e o log dos últimos e-mails.

### Microsoft To Do
1. Portal Azure › **Microsoft Entra ID › Registros de aplicativo › Novo registro**.
2. Tipos de conta: "somente esta organização" (ou multi-tenant + contas pessoais, se usar To Do pessoal — aí deixe `MS_TENANT_ID=common`).
3. URI de redirecionamento (Web): `https://SEU_DOMINIO/api/integrations/microsoft/callback` (a própria tela de Importações mostra a URI exata).
4. **Certificados e segredos** › novo segredo do cliente → `MS_CLIENT_SECRET`. A *ID do aplicativo (cliente)* → `MS_CLIENT_ID`. A *ID do diretório* → `MS_TENANT_ID`.
5. **Permissões de API** › Microsoft Graph › Delegadas: `Tasks.Read`, `User.Read`, `offline_access` (conceda consentimento de administrador se a empresa exigir).
6. Cada pessoa entra em **Importações › Conectar com conta Microsoft**. A partir daí, a sincronização é automática.

Regras da importação: tarefas são atribuídas a quem conectou; reimportar atualiza título/prazo/prioridade sem duplicar; tarefas já concluídas na origem **não** entram como concluídas (a regra da evidência vale para tudo).

### Videochamada em redes corporativas
A chamada é ponto a ponto (WebRTC) com servidores STUN públicos — funciona na maioria das redes. Se a conexão falhar atrás de firewall corporativo, configure um servidor TURN (`TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` — ex.: coturn próprio, Cloudflare Calls TURN ou Twilio).

## Perfis e regras de permissão

| Ação | Responsável | Criador da tarefa | Admin | Demais membros |
|---|---|---|---|---|
| Criar, editar, mover entre A Fazer / Em Andamento / Aguardando | ✔ | ✔ | ✔ | ✔ |
| **Concluir (com evidência)** | ✔ **somente ele** | — | — | — |
| Reabrir tarefa concluída | — | ✔ | ✔ | — |
| Excluir tarefa | — | ✔ | ✔ | — |
| Apagar evidência | ninguém (auditoria) | | | |
| Convidar pessoas, mudar perfis, desativar usuários | | | ✔ | |

## Estrutura do código

```
src/
  server.js          Express + Socket.IO + rotinas agendadas
  config.js          variáveis de ambiente, status, categorias
  db.js              banco: SQLite (local) ou PostgreSQL (DATABASE_URL), esquema e backup
  auth.js            sessão (JWT em cookie httpOnly), proteção de login
  realtime.js        chat em tempo real e sinalização das videochamadas
  storage.js         local / Azure Blob / S3
  mailer.js          envio de e-mails e layout
  integrations.js    Microsoft To Do (Graph), CSV e Trello
  kpis.js            cálculo dos indicadores
  reports.js         relatório mensal e lembretes de prazo
  jobs.js            rotinas automáticas (resistem a hospedagens que "dormem") e backup
  routes/            API REST
public/              frontend (SPA em JavaScript puro, sem etapa de build)
scripts/teste-api.mjs  teste ponta a ponta das regras de negócio
```

Teste automatizado das regras (convite, conclusão com evidência, reabertura, lembretes, importação, KPIs, chat): inicie o servidor com uma pasta de dados vazia e rode `npm run test:api`.
