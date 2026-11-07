#!/usr/bin/env bash
# =============================================================================
#  FinHub — instalação automática em servidor Ubuntu (Oracle Cloud Always Free)
#
#  No servidor, rode (troque pelo seu e-mail):
#    curl -fsSL https://raw.githubusercontent.com/Pablodutra1996/pablodutra/finhub/finhub/deploy/oracle-setup.sh | sudo bash -s -- seu@email.com
#
#  Opcional: domínio próprio como 2º parâmetro (o DNS já deve apontar para o IP do servidor):
#    ... | sudo bash -s -- seu@email.com finhub.suaempresa.com.br
#
#  Para ATUALIZAR o FinHub depois, rode o mesmo comando de novo (os dados são mantidos).
# =============================================================================
set -euo pipefail

REPO="https://github.com/Pablodutra1996/pablodutra.git"
BRANCH="finhub"
DIR="/opt/finhub-repo"
APP="$DIR/finhub"

ADMIN_EMAIL="${1:-}"
CUSTOM_DOMAIN="${2:-}"

say()  { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m    ✔ %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Rode com sudo (veja o comando no topo do script)."

if [ -z "$ADMIN_EMAIL" ] && [ ! -f "$APP/.env" ]; then
  read -r -p "Seu e-mail (será o administrador do FinHub): " ADMIN_EMAIL < /dev/tty
fi

# ---------------------------------------------------------------- 1. Pacotes
say "1/7 Instalando pacotes do sistema"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates openssl iptables-persistent >/dev/null
ok "git, curl, openssl, iptables-persistent"

# ---------------------------------------------------------------- 2. Memória (máquinas de 1 GB)
say "2/7 Verificando memória"
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$MEM_MB" -lt 2000 ] && ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ok "Memória baixa (${MEM_MB} MB): criado swap de 2 GB"
else
  ok "${MEM_MB} MB de RAM"
fi

# ---------------------------------------------------------------- 3. Docker
say "3/7 Instalando Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null 2>&1 || die "Docker Compose não encontrado após a instalação."
ok "$(docker --version)"

# ---------------------------------------------------------------- 4. Firewall do Ubuntu (Oracle bloqueia tudo exceto SSH)
say "4/7 Liberando portas 80 e 443 no firewall do servidor"
for PORT in 80 443; do
  if ! iptables -C INPUT -p tcp -m state --state NEW --dport "$PORT" -j ACCEPT 2>/dev/null; then
    REJECT_LINE=$(iptables -L INPUT --line-numbers -n | awk '$2=="REJECT" {print $1; exit}')
    if [ -n "$REJECT_LINE" ]; then
      iptables -I INPUT "$REJECT_LINE" -p tcp -m state --state NEW --dport "$PORT" -j ACCEPT
    else
      iptables -A INPUT -p tcp -m state --state NEW --dport "$PORT" -j ACCEPT
    fi
  fi
done
netfilter-persistent save >/dev/null 2>&1 || true
ok "Portas 80 e 443 liberadas (lembre-se também da Security List no painel da Oracle)"

# ---------------------------------------------------------------- 5. Código
say "5/7 Baixando o FinHub"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q --depth 1 origin "$BRANCH"
  git -C "$DIR" reset -q --hard "origin/$BRANCH"
  ok "Código atualizado"
else
  git clone -q --depth 1 -b "$BRANCH" "$REPO" "$DIR"
  ok "Código baixado em $DIR"
fi

# ---------------------------------------------------------------- 6. Configuração (.env)
say "6/7 Configurando"
if [ -f "$APP/.env" ]; then
  ok "Configuração existente mantida ($APP/.env)"
  DOMAIN=$(grep -E '^DOMAIN=' "$APP/.env" | cut -d= -f2-)
else
  PUBLIC_IP=$(curl -fsS -4 https://api.ipify.org || curl -fsS -4 https://ifconfig.me)
  [ -n "$PUBLIC_IP" ] || die "Não consegui descobrir o IP público do servidor."
  DOMAIN="${CUSTOM_DOMAIN:-${PUBLIC_IP//./-}.sslip.io}"
  cat > "$APP/.env" <<EOF
# Gerado por deploy/oracle-setup.sh em $(date -Iseconds). Edite e rode: cd $APP && docker compose up -d
DOMAIN=$DOMAIN
APP_URL=https://$DOMAIN
ADMIN_EMAIL=$ADMIN_EMAIL
NODE_ENV=production
JWT_SECRET=$(openssl rand -hex 48)
TZ_NAME=America/Sao_Paulo
TZ_OFFSET=-03:00
STORAGE_DRIVER=local

# ---- E-mail (preencha para enviar convites, lembretes e relatórios) ----
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
MAIL_FROM=

# ---- Oracle Object Storage (opcional, grátis até 20 GB) — veja deploy/ORACLE.md ----
# STORAGE_DRIVER=s3
# S3_BUCKET=finhub
# S3_REGION=sa-saopaulo-1
# S3_ENDPOINT=https://SEU_NAMESPACE.compat.objectstorage.sa-saopaulo-1.oraclecloud.com
# S3_ACCESS_KEY_ID=
# S3_SECRET_ACCESS_KEY=
# S3_FORCE_PATH_STYLE=true
# BACKUP_ENABLED=true

# ---- Microsoft To Do (opcional) ----
MS_CLIENT_ID=
MS_CLIENT_SECRET=
MS_TENANT_ID=common
EOF
  chmod 600 "$APP/.env"
  ok "Endereço: https://$DOMAIN"
  ok "Administrador: $ADMIN_EMAIL"
fi

# ---------------------------------------------------------------- 7. Subir
say "7/7 Construindo e iniciando (pode levar 3–8 minutos na primeira vez)"
cd "$APP"
docker compose up -d --build
docker image prune -f >/dev/null 2>&1 || true

printf '    Aguardando o site responder com HTTPS'
for _ in $(seq 1 60); do
  if curl -fsS -m 5 "https://$DOMAIN/api/health" >/dev/null 2>&1; then
    printf '\n'
    ok "FinHub no ar!"
    cat <<EOF

  ┌────────────────────────────────────────────────────────────────┐
     Acesse:  https://$DOMAIN
     Crie a conta de administrador com: $(grep -E '^ADMIN_EMAIL=' .env | cut -d= -f2-)
  └────────────────────────────────────────────────────────────────┘

  Comandos úteis (dentro de $APP):
    Ver logs ............. sudo docker compose logs -f finhub
    Reiniciar ............ sudo docker compose restart
    Editar configuração .. sudo nano .env   (depois: sudo docker compose up -d)
    Atualizar o FinHub ... rode de novo o comando de instalação

EOF
    exit 0
  fi
  printf '.'; sleep 5
done

printf '\n'
cat <<EOF
⚠ O FinHub subiu, mas o endereço https://$DOMAIN ainda não respondeu.
  Causa mais comum: a Security List da Oracle não libera as portas 80 e 443
  (passo "Liberar portas" do guia deploy/ORACLE.md). Depois de liberar, aguarde
  1–2 minutos e acesse o endereço — o certificado HTTPS é gerado automaticamente.

  Diagnóstico:  cd $APP && sudo docker compose logs --tail 50
EOF
exit 1
