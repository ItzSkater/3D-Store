#!/usr/bin/env bash
#
# Установка 3D-Store на CentOS Stream 9 (также подходит для RHEL/Rocky/Alma 9).
# Запускать от root:
#
#   curl -fsSL https://raw.githubusercontent.com/ItzSkater/3D-Store/main/deploy/setup-centos.sh -o setup.sh
#   bash setup.sh
#
# Скрипт идемпотентный — можно запускать повторно.

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/ItzSkater/3D-Store.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="/opt/3d-store"
DATA_DIR="/var/lib/3d-store"
ENV_FILE="/etc/3d-store.env"
APP_USER="webstore"
NODE_MAJOR="${NODE_MAJOR:-22}"

log()  { echo -e "\n\033[1;32m==> $*\033[0m"; }
warn() { echo -e "\033[1;33m[!] $*\033[0m"; }

if [[ $EUID -ne 0 ]]; then
  echo "Запустите скрипт от root:  sudo bash $0" >&2
  exit 1
fi

log "1/8 Базовые пакеты"
dnf install -y git nginx policycoreutils-python-utils curl >/dev/null

log "2/8 Node.js ${NODE_MAJOR}"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -c2- | cut -d. -f1)" -lt "$NODE_MAJOR" ]]; then
  curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  dnf install -y nodejs >/dev/null
fi
echo "Node: $(node -v)"

log "3/8 Пользователь и каталоги"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --shell /sbin/nologin --home-dir "$APP_DIR" "$APP_USER"
mkdir -p "$DATA_DIR/uploads"

log "4/8 Код приложения"
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" fetch origin "$BRANCH" --quiet
  git -C "$APP_DIR" reset --hard "origin/$BRANCH" --quiet
else
  rm -rf "$APP_DIR"
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$APP_DIR" --quiet
fi

log "5/8 Зависимости"
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund

chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_DIR"

log "6/8 Настройки (${ENV_FILE})"
if [[ ! -f "$ENV_FILE" ]]; then
  OWNER_PASS="$(head -c 9 /dev/urandom | base64 | tr -d '/+=' | head -c 12)"
  cat > "$ENV_FILE" <<EOF
# Настройки 3D-Store. После правки: systemctl restart 3d-store
PORT=3000
DATA_DIR=${DATA_DIR}

# Стартовый пароль владельца (нужен только при первом запуске).
OWNER_PASSWORD=${OWNER_PASS}

# Уведомления в Telegram
TELEGRAM_CHAT_ID=8763963310
TELEGRAM_BOT_TOKEN=

# Сброс пароля: впишите новый пароль, перезапустите сервис,
# войдите и снова очистите эту строку.
RESET_OWNER_PASSWORD=
EOF
  chmod 600 "$ENV_FILE"
  echo "Сгенерирован пароль владельца: ${OWNER_PASS}"
else
  echo "Файл настроек уже существует — оставляю без изменений."
fi

log "7/8 systemd"
install -m 644 "$APP_DIR/deploy/3d-store.service" /etc/systemd/system/3d-store.service
systemctl daemon-reload
systemctl enable --now 3d-store
sleep 2
systemctl is-active --quiet 3d-store && echo "Сервис запущен." || warn "Сервис не поднялся: journalctl -u 3d-store -n 50"

log "8/8 nginx, firewalld, SELinux"
install -m 644 "$APP_DIR/deploy/nginx-3d-store.conf" /etc/nginx/conf.d/3d-store.conf
# SELinux в CentOS по умолчанию запрещает nginx ходить в локальный порт
setsebool -P httpd_can_network_connect 1
nginx -t
systemctl enable --now nginx
systemctl reload nginx

if systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-service=http  >/dev/null
  firewall-cmd --permanent --add-service=https >/dev/null
  firewall-cmd --reload >/dev/null
  echo "Порты 80/443 открыты."
fi

IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
cat <<EOF

============================================================
  Готово! Сайт:      http://${IP}
  Админка:           http://${IP}/admin
  Пароль владельца:  см. OWNER_PASSWORD в ${ENV_FILE}

  Логи:              journalctl -u 3d-store -f
  Перезапуск:        systemctl restart 3d-store
  Обновление кода:   bash ${APP_DIR}/deploy/update.sh

  Telegram: впишите TELEGRAM_BOT_TOKEN в ${ENV_FILE}
            и выполните systemctl restart 3d-store
            (либо задайте токен в админке).

  Если есть домен — направьте его A-записью на ${IP}, затем:
    dnf install -y epel-release && dnf install -y certbot python3-certbot-nginx
    certbot --nginx -d ваш-домен.ru
============================================================
EOF
