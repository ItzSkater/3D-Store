#!/usr/bin/env bash
#
# Обновление 3D-Store до свежей версии из GitHub.
# Запускать от root:  bash /opt/3d-store/deploy/update.sh

set -euo pipefail

APP_DIR="/opt/3d-store"
BRANCH="${BRANCH:-main}"
APP_USER="webstore"

if [[ $EUID -ne 0 ]]; then
  echo "Запустите от root: sudo bash $0" >&2
  exit 1
fi

echo "==> Забираю обновления из GitHub"
# Каталог принадлежит пользователю webstore, а git запущен от root —
# без этого git отказывается работать ("dubious ownership").
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
git -C "$APP_DIR" fetch origin "$BRANCH" --quiet
git -C "$APP_DIR" reset --hard "origin/$BRANCH" --quiet

echo "==> Обновляю зависимости"
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund

chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# Конфиг nginx мог измениться вместе с кодом (лимит размера загрузок).
# Файл НЕ перезаписываем: certbot дописывает в него HTTPS-секцию, её терять нельзя.
NGX=/etc/nginx/conf.d/3d-store.conf
if [[ -f "$NGX" ]]; then
  WANT="$(grep -oP 'client_max_body_size\s+\K[^;]+' "$APP_DIR/deploy/nginx-3d-store.conf" | head -1)"
  HAVE="$(grep -oP 'client_max_body_size\s+\K[^;]+' "$NGX" | head -1 || true)"
  if [[ -n "$WANT" && "$WANT" != "${HAVE:-}" ]]; then
    echo "==> Поднимаю лимит загрузки в nginx: ${HAVE:-нет} -> $WANT"
    if [[ -n "${HAVE:-}" ]]; then
      sed -i -E "s/client_max_body_size[[:space:]]+[^;]+;/client_max_body_size ${WANT};/g" "$NGX"
    else
      sed -i -E "0,/^\s*server\s*\{/s//server {\n    client_max_body_size ${WANT};/" "$NGX"
    fi
    nginx -t && systemctl reload nginx
  fi
fi

echo "==> Перезапускаю сервис"
systemctl restart 3d-store
sleep 2
if systemctl is-active --quiet 3d-store; then
  echo "Готово. Сайт обновлён и работает."
else
  echo "Сервис не запустился. Смотрите: journalctl -u 3d-store -n 50" >&2
  exit 1
fi
