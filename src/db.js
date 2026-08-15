'use strict';

const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');

// Хранилище данных:
//  - По умолчанию — локальный файл SQLite (для разработки), путь в DATA_DIR.
//  - В продакшене задайте DATABASE_URL (напр. Turso: libsql://...) и
//    DATABASE_AUTH_TOKEN — тогда данные хранятся в облаке и не теряются
//    при перезапуске бесплатного хостинга.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!process.env.DATABASE_URL && !fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const url = process.env.DATABASE_URL || 'file:' + path.join(DATA_DIR, 'store.db');
const authToken = process.env.DATABASE_AUTH_TOKEN || undefined;

const client = createClient({ url, authToken });

// Удобные обёртки над асинхронным клиентом libsql.
async function run(sql, args = []) {
  return client.execute({ sql, args });
}
async function get(sql, args = []) {
  const res = await client.execute({ sql, args });
  return res.rows[0];
}
async function all(sql, args = []) {
  const res = await client.execute({ sql, args });
  return res.rows;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS users (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     username TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     display_name TEXT DEFAULT '',
     phone TEXT DEFAULT '',
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  // Фото моделей хранятся прямо в базе (чтобы не зависеть от диска сервера).
  `CREATE TABLE IF NOT EXISTS images (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     mime TEXT NOT NULL DEFAULT 'image/jpeg',
     data BLOB NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS products (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     description TEXT DEFAULT '',
     price REAL NOT NULL DEFAULT 0,
     image TEXT DEFAULT '',
     is_active INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS variants (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     product_id INTEGER NOT NULL,
     name TEXT NOT NULL,
     extra_price REAL NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS orders (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     token TEXT NOT NULL UNIQUE,
     user_id INTEGER,
     product_id INTEGER,
     variant_id INTEGER,
     product_name TEXT NOT NULL,
     variant_name TEXT DEFAULT '',
     unit_price REAL NOT NULL DEFAULT 0,
     quantity INTEGER NOT NULL DEFAULT 1,
     total REAL NOT NULL DEFAULT 0,
     customer_name TEXT NOT NULL,
     phone TEXT DEFAULT '',
     address TEXT DEFAULT '',
     status TEXT NOT NULL DEFAULT 'new',
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS messages (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     order_id INTEGER NOT NULL,
     sender TEXT NOT NULL,
     body TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token TEXT PRIMARY KEY,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS user_sessions (
     token TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  // Состояние диалога с ботом (пошаговое оформление заказа)
  `CREATE TABLE IF NOT EXISTS tg_state (
     chat_id TEXT PRIMARY KEY,
     state TEXT NOT NULL DEFAULT '',
     data TEXT NOT NULL DEFAULT '{}',
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_variants_product ON variants(product_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_order ON messages(order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at)`,
];

// Добавляет колонку, если её ещё нет (для баз, созданных ранней версией).
async function addColumnIfMissing(table, column, definition) {
  const res = await client.execute(`PRAGMA table_info(${table})`);
  const exists = res.rows.some((r) => r.name === column);
  if (!exists) {
    await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function init() {
  for (const stmt of SCHEMA) {
    await client.execute(stmt);
  }
  // Привязка аккаунта клиента к Telegram
  await addColumnIfMissing('users', 'telegram_chat_id', "TEXT DEFAULT ''");
  await client.execute(
    'CREATE INDEX IF NOT EXISTS idx_users_tg ON users(telegram_chat_id)'
  );
}

module.exports = { client, run, get, all, init };
