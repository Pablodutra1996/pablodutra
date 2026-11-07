# Publicar o FinHub de graça na Oracle Cloud (Always Free)

Resultado: o FinHub no ar 24h, com HTTPS, num endereço como `https://129-80-12-34.sslip.io`, sem custo mensal.
Tempo estimado: 30–45 minutos (a maior parte é cadastro e espera).

---

## Parte 1 — Criar a conta (10 min)

1. Acesse **https://signup.cloud.oracle.com** e clique em **Start for free**.
2. Preencha país (**Brasil**), nome e e-mail; confirme o e-mail.
3. **Cloud Account Name**: um nome curto, ex.: `futurumfin` (é o "nome da empresa" no login).
4. **Home Region**: escolha **Brazil East (São Paulo)**.
   ⚠️ Não dá para trocar depois — e os recursos grátis só existem na região inicial.
5. Informe endereço e um **cartão de crédito**. É só verificação: a Oracle faz uma pré-autorização pequena e devolve. Nada é cobrado enquanto você usar só recursos *Always Free*.
6. Aguarde o e-mail "Your account is ready" (de alguns minutos a algumas horas).

> 💡 **Recomendado depois que a conta estiver pronta:** em *Billing › Upgrade and Manage Payment*, mude para **Pay As You Go**.
> Continua **grátis** dentro dos limites Always Free, mas (1) diminui muito o erro "Out of capacity" ao criar a máquina e (2) evita que a Oracle **desligue máquinas grátis ociosas**, o que pode acontecer em contas só-gratuitas com pouco uso (caso de 3 usuários).
> Para não ter surpresa, crie um alerta de orçamento em *Billing › Budgets* com limite de US$ 1.

---

## Parte 2 — Criar o servidor (10 min)

1. No painel (cloud.oracle.com), menu ☰ › **Compute › Instances › Create instance**.
2. **Name**: `finhub`.
3. **Image and shape › Edit**:
   - **Image**: *Change image* › **Canonical Ubuntu 22.04** (ou 24.04).
   - **Shape**: *Change shape* › **Ampere** › **VM.Standard.A1.Flex** com **2 OCPUs e 12 GB** de memória (sobra; o grátis vai até 4 e 24 GB).
     Se der *Out of capacity*: tente outro *Availability Domain*, tente mais tarde, ou use **Specialty and previous generation › VM.Standard.E2.1.Micro** (1 GB, também grátis — funciona para 3 pessoas).
   - Confira o selo **"Always Free-eligible"**.
4. **Networking**: deixe criar uma *new virtual cloud network* e marque **Assign a public IPv4 address**.
5. **Add SSH keys**: **Generate a key pair for me** › clique em **Save private key** (guarde o arquivo `.key` — é a "chave" do servidor).
6. **Boot volume**: pode deixar o padrão (até 200 GB no total são grátis).
7. **Create**. Em 1–2 minutos o status fica **Running**. Anote o **Public IP address** (ex.: `129.80.12.34`).

---

## Parte 3 — Liberar o acesso pela internet (3 min)

A Oracle bloqueia tudo por padrão, exceto o acesso SSH.

1. Na página da instância, em **Primary VNIC**, clique no link da **Subnet**.
2. Aba **Security** (ou *Security Lists*) › clique na *Default Security List*.
3. **Add Ingress Rules** e crie **uma regra** com:
   - Source CIDR: `0.0.0.0/0`
   - IP Protocol: `TCP`
   - Destination Port Range: `80,443`
4. **Add Ingress Rules** para salvar.

(O firewall *de dentro* do servidor o script de instalação libera sozinho.)

---

## Parte 4 — Instalar o FinHub (10 min, quase tudo automático)

### Conectar no servidor
O jeito mais fácil, sem instalar nada: na página da instância, clique em **Cloud Shell** (ícone `>_` no topo do painel) e, quando abrir:

1. No menu ⚙ do Cloud Shell, **Upload** › envie o arquivo `.key` salvo na Parte 2.
2. Rode (troque o IP):
   ```bash
   chmod 600 ~/*.key && ssh -i ~/*.key ubuntu@129.80.12.34
   ```
   Responda `yes` na primeira vez.

> Alternativa pelo Windows: abra o **PowerShell** na pasta onde está o `.key` e rode `ssh -i .\ssh-key-AAAA-MM-DD.key ubuntu@129.80.12.34`.

### Rodar a instalação
Já dentro do servidor (o terminal mostra `ubuntu@finhub:~$`), cole **um único comando** trocando o e-mail:

```bash
curl -fsSL https://raw.githubusercontent.com/Pablodutra1996/pablodutra/finhub/finhub/deploy/oracle-setup.sh | sudo bash -s -- pablo.dutra@futurum.capital
```

O script, sozinho: instala o Docker, libera o firewall, baixa o FinHub, gera um segredo de sessão, configura o HTTPS (Let's Encrypt) e sobe o sistema. Ao final aparece:

```
Acesse:  https://129-80-12-34.sslip.io
```

> **sslip.io** é um serviço gratuito que transforma o IP num endereço válido para HTTPS — não precisa comprar domínio.
> Tem domínio próprio (ex.: `finhub.futurum.capital`)? Crie um registro **A** apontando para o IP e rode o comando com o domínio como 2º parâmetro: `... | sudo bash -s -- pablo.dutra@futurum.capital finhub.futurum.capital`

---

## Parte 5 — Primeiro acesso

1. Abra o endereço mostrado.
2. Crie a conta de administrador **com o e-mail informado no comando** (só ele é aceito).
3. **Equipe e convites** › convide os colegas › **Copiar link** e envie pelo Teams/WhatsApp.

---

## Configurações opcionais

### E-mail automático (convites, lembretes de atraso, relatório mensal)
```bash
cd /opt/finhub-repo/finhub && sudo nano .env
```
Preencha `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` (veja o README principal), salve (`Ctrl+O`, `Enter`, `Ctrl+X`) e aplique:
```bash
sudo docker compose up -d
```

### Arquivos e backup no Oracle Object Storage (grátis até 20 GB)
1. Painel › **Storage › Buckets › Create bucket** com nome `finhub` (privado, padrão).
2. Anote o **Namespace** (aparece na página do bucket).
3. Ícone do seu usuário › **My profile › Customer secret keys › Generate secret key** → copie a *Secret* (só aparece uma vez) e o *Access key*.
4. No `.env`, troque `STORAGE_DRIVER=local` por `STORAGE_DRIVER=s3` e descomente as linhas `S3_*` com namespace, chaves e `BACKUP_ENABLED=true`. Aplique com `sudo docker compose up -d`.
   O banco passa a ter backup diário às 02:00 no bucket. (Anexos enviados antes da troca continuam no disco do servidor.)

---

## Manutenção

| Tarefa | Comando (dentro de `/opt/finhub-repo/finhub`) |
|---|---|
| Atualizar o FinHub para a versão nova do GitHub | rodar de novo o comando de instalação (dados preservados) |
| Ver o que está acontecendo | `sudo docker compose logs -f finhub` |
| Reiniciar | `sudo docker compose restart` |
| Backup manual do banco para o seu PC | `sudo docker compose cp finhub:/app/data/finhub.db ./finhub-backup.db` e baixar via Cloud Shell (*Download*) |

## Problemas comuns

| Sintoma | Solução |
|---|---|
| *Out of capacity* ao criar a instância | outro Availability Domain, tentar mais tarde, usar E2.1.Micro, ou upgrade para Pay As You Go |
| O script termina com "ainda não respondeu" | faltou a regra da **Parte 3**; crie, espere 2 min e abra o endereço |
| Navegador diz "conexão não segura" logo após instalar | o certificado leva 1–2 min para ser emitido; recarregue |
| Câmera/microfone não funcionam | acesse sempre pelo endereço `https://...` |
| Chamada não conecta entre redes diferentes | configure um servidor TURN (`TURN_*` no `.env`) |
