# Publicar o FinHub de graça e sem cartão: Render Free + Supabase

| Peça | Serviço | Plano |
|---|---|---|
| Site (o FinHub) | **Render** | Free — sem cartão |
| Banco de dados PostgreSQL + backups | **Supabase** | Free — sem cartão |
| Arquivos (evidências, anexos, fotos) | **Supabase Storage** | Free (1 GB) |
| Manter o site acordado 24h | **UptimeRobot** | Free |
| E-mails (convites, lembretes, relatório mensal) — opcional | **Brevo** | Free (300/dia) |

Tempo estimado: 30–40 minutos. Vá preenchendo a tabela "Anote aqui" no final — você vai colar esses valores no Render.

> Os planos gratuitos mudam de tempos em tempos; confira os limites atuais no site de cada serviço.

---

## Parte 1 — Supabase: banco de dados (10 min)

1. Acesse **https://supabase.com** › **Start your project** › entre com o **GitHub** (o mesmo `Pablodutra1996`).
2. **New project**:
   - **Name**: `finhub`
   - **Database Password**: clique em **Generate a password** e **copie para a tabela** (item A). ⚠️ Ela não aparece de novo.
   - **Region**: **East US (North Virginia)** — a mesma do Render, deixa o sistema mais rápido.
   - **Create new project** e aguarde ~2 minutos.
3. No topo do projeto, clique em **Connect**.
4. Escolha **Session pooler** (não use "Direct connection") e copie a **URI**. Ela é parecida com:
   ```
   postgresql://postgres.abcdefghijk:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:5432/postgres
   ```
5. Troque `[YOUR-PASSWORD]` pela senha do item A (sem os colchetes) e anote como **item B**.

O FinHub cria as tabelas sozinho no primeiro acesso — não precisa rodar nada no Supabase.

## Parte 2 — Supabase: armazenamento de arquivos (5 min)

1. Menu da esquerda › **Storage** › **New bucket**:
   - **Name**: `finhub`
   - **Public bucket**: **desligado** (privado — os arquivos só abrem pela plataforma, com login)
   - **Create**.
2. Ainda em Storage, abra **Settings** (ou **S3 Connection** / **S3 Configuration**):
   - Copie o **Endpoint** → **item C** (ex.: `https://abcdefghijk.supabase.co/storage/v1/s3`)
   - Copie a **Region** → **item D** (ex.: `us-east-1`)
3. Em **S3 Access Keys** › **New access key** (descrição: `finhub`):
   - Copie o **Access key ID** → **item E**
   - Copie o **Secret access key** → **item F** ⚠️ só aparece uma vez.

## Parte 3 — Render: publicar o site (10 min)

1. Acesse **https://dashboard.render.com** (a conta que você já criou).
2. **New +** › **Blueprint** › escolha o repositório **`Pablodutra1996/pablodutra`**.
3. Preencha:
   - **Blueprint Name**: `finhub`
   - **Branch**: **`finhub`**
   - **Blueprint Path**: **`finhub/render.yaml`**
4. Aparece o serviço **finhub (Free)** pedindo as variáveis. Preencha:

   | Variável | Valor |
   |---|---|
   | `ADMIN_EMAIL` | `pablo.dutra@futurum.capital` |
   | `DATABASE_URL` | item **B** |
   | `S3_ENDPOINT` | item **C** |
   | `S3_REGION` | item **D** |
   | `S3_ACCESS_KEY_ID` | item **E** |
   | `S3_SECRET_ACCESS_KEY` | item **F** |
   | `BREVO_API_KEY` | deixe em branco por enquanto (Parte 6) |
   | `MAIL_FROM` | deixe em branco por enquanto (Parte 6) |

5. **Deploy Blueprint**. Acompanhe em **Logs**; leva 5–10 minutos. Quando aparecer
   `FinHub rodando em https://finhub-xxxx.onrender.com` e o status ficar **Live**, copie o endereço do topo da página → **item G**.

## Parte 4 — Primeiro acesso (2 min)

1. Abra o **item G** no navegador.
2. A tela pede para criar o administrador: use **`pablo.dutra@futurum.capital`** (só esse e-mail é aceito) e uma senha forte.
3. **Equipe e convites** › convide os colegas › **Copiar link** › envie pelo Teams/WhatsApp. Cada um cria a própria senha e já entra.

## Parte 5 — UptimeRobot: manter o site acordado (5 min)

No plano grátis, o Render "adormece" o site após 15 minutos sem acesso, e a primeira abertura seguinte demora ~1 minuto. Para evitar isso (e para que lembretes e relatórios saiam no horário):

1. Acesse **https://uptimerobot.com** › **Register for FREE** (sem cartão).
2. **+ New monitor**:
   - **Monitor Type**: `HTTP(s)`
   - **Friendly Name**: `FinHub`
   - **URL**: item **G** + `/api/health` (ex.: `https://finhub-xxxx.onrender.com/api/health`)
   - **Monitoring Interval**: **5 minutes**
   - **Create Monitor**.

Bônus: o UptimeRobot te avisa por e-mail se o site sair do ar.

## Parte 6 — E-mails automáticos com Brevo (opcional, 10 min)

Sem isso, tudo funciona — mas convites precisam ser enviados com **Copiar link**, e lembretes de atraso / relatório mensal não chegam por e-mail.

1. Acesse **https://www.brevo.com** › crie a conta grátis (sem cartão).
2. **Senders, Domains & Dedicated IPs** › **Senders** › **Add a sender**: seu e-mail (ex.: `pablo.dutra@futurum.capital`) e nome `FinHub Financeiro`. Confirme pelo link que chega na sua caixa.
3. Menu do seu perfil › **SMTP & API** › aba **API Keys** › **Generate a new API key** (nome `finhub`) → copie.
4. No Render: serviço **finhub** › **Environment** › preencha:
   - `BREVO_API_KEY` = a chave copiada
   - `MAIL_FROM` = `FinHub Financeiro <pablo.dutra@futurum.capital>` (o mesmo e-mail confirmado no passo 2)
   - **Save Changes** (o Render reinicia sozinho em ~2 min).
5. Teste: no FinHub, **Equipe e convites** › **Me enviar o resumo do mês**.

> Dica: e-mails enviados por um serviço externo em nome de um endereço corporativo podem cair no spam no começo. Peça aos colegas para marcar como "não é spam". Para melhorar a entrega, o TI pode autenticar o domínio `futurum.capital` no Brevo (*Domains › Add a domain*).

---

## Anote aqui

| Item | O que é | Valor |
|---|---|---|
| A | Senha do banco (Supabase) | |
| B | DATABASE_URL (Session pooler, com a senha) | |
| C | S3 Endpoint (Supabase Storage) | |
| D | S3 Region | |
| E | S3 Access key ID | |
| F | S3 Secret access key | |
| G | Endereço do site (Render) | |

⚠️ Guarde essas informações em local seguro (ex.: cofre de senhas). Não envie por chat nem coloque no GitHub.

## Segurança e backup — o que já fica funcionando

- Banco PostgreSQL gerenciado pelo Supabase, com conexão criptografada.
- **Backup diário automático** do banco inteiro (arquivo JSON) no bucket `finhub`, pasta `backups/`.
- Arquivos privados: só abrem para quem está logado na plataforma.
- HTTPS no endereço do Render.
- Acesso somente por convite; administrador travado no seu e-mail.

## Problemas comuns

| Sintoma | Solução |
|---|---|
| Deploy falha com erro de banco (`password authentication failed`) | a senha no `DATABASE_URL` está errada, ou ficaram os colchetes `[ ]` |
| Erro `ENOTFOUND` / `ENETUNREACH` no banco | você copiou a "Direct connection"; use a **Session pooler** |
| Erro ao enviar arquivo / foto | confira `S3_ENDPOINT`, `S3_REGION` e as chaves; o bucket precisa se chamar `finhub` |
| Site demora ~1 min para abrir | faltou a Parte 5 (UptimeRobot) |
| Supabase avisa que o projeto será pausado | acontece após 7 dias sem uso; com o UptimeRobot ativo o FinHub consulta o banco a cada 5 min e isso não ocorre |
| E-mail não chega | confira em *Equipe e convites › Últimos e-mails*; o `MAIL_FROM` precisa ser o remetente confirmado no Brevo |
