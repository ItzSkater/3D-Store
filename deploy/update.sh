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

echo "==> Перезапускаю сервис"
systemctl restart 3d-store
sleep 2
if systemctl is-active --quiet 3d-store; then
  echo "Готово. Сайт обновлён и работает."
else
  echo "Сервис не запустился. Смотрите: journalctl -u 3d-store -n 50" >&2
  exit 1
fi
