#!/usr/bin/env bash
#
# Включение HTTPS (Let's Encrypt) для 3D-Store.
# Подходит для DuckDNS и любого другого домена.
#
# Запускать от root ПОСЛЕ setup-centos.sh:
#
#   bash /opt/3d-store/deploy/setup-https.sh мой-магазин.duckdns.org
#   bash /opt/3d-store/deploy/setup-https.sh мой-магазин.duckdns.org почта@example.com
#
# Второй аргумент (email) необязателен — на него приходят напоминания
# об истечении сертификата.

set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
NGINX_CONF="/etc/nginx/conf.d/3d-store.conf"

log()  { echo -e "\n\033[1;32m==> $*\033[0m"; }
warn() { echo -e "\033[1;33m[!] $*\033[0m"; }
die()  { echo -e "\033[1;31m[X] $*\033[0m" >&2; exit 1; }

if [[ $EUID -ne 0 ]]; then
  die "Запустите от root:  sudo bash $0 ваш-домен.duckdns.org"
fi

if [[ -z "$DOMAIN" ]]; then
  die "Укажите домен. Пример:  bash $0 мой-магазин.duckdns.org"
fi

[[ -f "$NGINX_CONF" ]] || die "Не найден $NGINX_CONF — сначала выполните setup-centos.sh"

log "1/5 Проверяю, что домен указывает на этот сервер"
SERVER_IP="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
DOMAIN_IP="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
echo "    IP сервера: ${SERVER_IP:-неизвестен}"
echo "    IP домена:  ${DOMAIN_IP:-не определяется}"

if [[ -z "$DOMAIN_IP" ]]; then
  die "Домен $DOMAIN не резолвится. Проверьте запись в DuckDNS и подождите пару минут."
fi
if [[ -n "$SERVER_IP" && "$DOMAIN_IP" != "$SERVER_IP" ]]; then
  warn "Домен указывает на $DOMAIN_IP, а сервер — $SERVER_IP."
  warn "Обновите IP в панели DuckDNS, иначе выпуск сертификата не пройдёт."
  read -rp "Продолжить всё равно? [y/N] " ans
  [[ "${ans,,}" == "y" ]] || exit 1
fi

log "2/5 Устанавливаю certbot"
dnf install -y epel-release >/dev/null 2>&1 || true
dnf install -y certbot python3-certbot-nginx >/dev/null

log "3/5 Прописываю домен в nginx"
# Заменяем server_name (в исходном конфиге стоит "_")
sed -i -E "s/^(\s*)server_name\s+.*;/\1server_name ${DOMAIN};/" "$NGINX_CONF"
nginx -t
systemctl reload nginx

log "4/5 Получаю сертификат Let's Encrypt"
CERTBOT_ARGS=(--nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect)
if [[ -n "$EMAIL" ]]; then
  CERTBOT_ARGS+=(-m "$EMAIL")
else
  CERTBOT_ARGS+=(--register-unsafely-without-email)
fi
certbot "${CERTBOT_ARGS[@]}"

log "5/5 Включаю автопродление"
# В зависимости от версии таймер называется certbot-renew.timer или certbot.timer
systemctl enable --now certbot-renew.timer 2>/dev/null \
  || systemctl enable --now certbot.timer 2>/dev/null \
  || warn "Таймер автопродления не найден — проверьте: systemctl list-timers | grep certbot"

certbot renew --dry-run >/dev/null 2>&1 \
  && echo "    Проверка автопродления прошла успешно." \
  || warn "Тестовое продление не прошло — проверьте: certbot renew --dry-run"

cat <<EOF

============================================================
  HTTPS включён!

  Сайт:     https://${DOMAIN}
  Админка:  https://${DOMAIN}/admin

  Сертификат бесплатный, продлевается автоматически каждые 60 дней.
  HTTP автоматически перенаправляется на HTTPS.

  Проверить срок:  certbot certificates
============================================================
EOF
