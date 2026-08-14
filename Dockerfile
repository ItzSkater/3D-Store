# 3D-Store — образ для Fly.io
FROM node:22-bookworm-slim

WORKDIR /app

# Инструменты для сборки нативного модуля better-sqlite3
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Сначала зависимости — для кэширования слоёв
COPY package*.json ./
RUN npm ci --omit=dev

# Затем код
COPY . .

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    UPLOAD_DIR=/data/uploads

EXPOSE 3000

CMD ["node", "src/server.js"]
