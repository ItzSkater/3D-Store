'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'store.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  -- Аккаунты клиентов (без email, только юзернейм + пароль)
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name  TEXT DEFAULT '',
    phone         TEXT DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS products (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT DEFAULT '',
    price       REAL NOT NULL DEFAULT 0,
    image       TEXT DEFAULT '',
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Варианты филамента для конкретной модели
  CREATE TABLE IF NOT EXISTS variants (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id  INTEGER NOT NULL,
    name        TEXT NOT NULL,          -- напр. "PLA Красный", "PETG Чёрный"
    extra_price REAL NOT NULL DEFAULT 0, -- доплата к базовой цене
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS orders (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    token         TEXT NOT NULL UNIQUE,   -- секретная ссылка клиента на чат/заказ
    user_id       INTEGER,                -- владелец заказа (аккаунт клиента)
    product_id    INTEGER,
    variant_id    INTEGER,
    product_name  TEXT NOT NULL,          -- снимок на момент заказа
    variant_name  TEXT DEFAULT '',
    unit_price    REAL NOT NULL DEFAULT 0,
    quantity      INTEGER NOT NULL DEFAULT 1,
    total         REAL NOT NULL DEFAULT 0,
    customer_name TEXT NOT NULL,
    phone         TEXT DEFAULT '',
    address       TEXT DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'new', -- new | confirmed | shipped | done | cancelled
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
    FOREIGN KEY (variant_id) REFERENCES variants(id) ON DELETE SET NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id   INTEGER NOT NULL,
    sender     TEXT NOT NULL,             -- 'owner' | 'customer'
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
  );

  -- Сессии владельца
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Сессии клиентов (аккаунтов)
  CREATE TABLE IF NOT EXISTS user_sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_variants_product ON variants(product_id);
  CREATE INDEX IF NOT EXISTS idx_messages_order  ON messages(order_id);
  CREATE INDEX IF NOT EXISTS idx_orders_created  ON orders(created_at);
`);

module.exports = db;
