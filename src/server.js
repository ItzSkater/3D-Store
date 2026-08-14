'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const multer = require('multer');

const db = require('./db');
const notify = require('./notify');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Оборачиваем async-обработчики, чтобы ошибки уходили в общий обработчик.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ------- Загрузка изображений (в память, затем в БД) -------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 МБ
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Разрешены только изображения'));
  },
});

async function saveImage(file) {
  if (!file) return '';
  const res = await db.run('INSERT INTO images (mime, data) VALUES (?, ?)', [
    file.mimetype || 'image/jpeg',
    file.buffer,
  ]);
  return String(Number(res.lastInsertRowid));
}
async function deleteImage(imageId) {
  if (!imageId) return;
  const id = parseInt(imageId, 10);
  if (id) await db.run('DELETE FROM images WHERE id = ?', [id]);
}

// ------- Первичная настройка: пароль владельца -------
async function ensureOwnerPassword() {
  const existing = await db.get('SELECT value FROM settings WHERE key = ?', ['owner_password_hash']);
  if (!existing) {
    const initial = process.env.OWNER_PASSWORD || 'admin';
    const hash = bcrypt.hashSync(initial, 10);
    await db.run('INSERT INTO settings (key, value) VALUES (?, ?)', ['owner_password_hash', hash]);
    console.log('[3D-Store] Пароль владельца установлен. По умолчанию: "admin" (смените его в админке!).');
  }
}

async function getOwnerHash() {
  const row = await db.get('SELECT value FROM settings WHERE key = ?', ['owner_password_hash']);
  return row ? row.value : '';
}

// ------- Аутентификация -------
function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

async function isOwner(req) {
  const token = req.cookies && req.cookies.owner_session;
  if (!token) return false;
  const row = await db.get('SELECT token FROM sessions WHERE token = ?', [token]);
  return !!row;
}

function requireOwner(req, res, next) {
  isOwner(req)
    .then((ok) => (ok ? next() : res.status(401).json({ error: 'Требуется вход владельца' })))
    .catch(next);
}

async function currentUser(req) {
  const token = req.cookies && req.cookies.user_session;
  if (!token) return null;
  const row = await db.get(
    'SELECT u.* FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?',
    [token]
  );
  return row || null;
}

function requireUser(req, res, next) {
  currentUser(req)
    .then((u) => {
      if (!u) return res.status(401).json({ error: 'Войдите в аккаунт' });
      req.user = u;
      next();
    })
    .catch(next);
}

function publicUser(u) {
  return { id: u.id, username: u.username, display_name: u.display_name || u.username, phone: u.phone || '' };
}

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,24}$/;

// ============ Отдача изображений ============
app.get('/img/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(404).end();
  const row = await db.get('SELECT mime, data FROM images WHERE id = ?', [id]);
  if (!row) return res.status(404).end();
  const data = row.data;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  res.set('Content-Type', row.mime || 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(buf);
}));

// ============ API ============
app.get('/api/me', wrap(async (req, res) => {
  const [owner, u] = await Promise.all([isOwner(req), currentUser(req)]);
  res.json({ owner, user: u ? publicUser(u) : null });
}));

// --- Регистрация клиента ---
app.post('/api/register', wrap(async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const display_name = String(req.body.display_name || '').trim();
  const phone = String(req.body.phone || '').trim();

  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Юзернейм: 3–24 символа, латиница, цифры, . _ -' });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: 'Пароль слишком короткий (минимум 4 символа)' });
  }
  const exists = await db.get('SELECT id FROM users WHERE username = ? COLLATE NOCASE', [username]);
  if (exists) return res.status(409).json({ error: 'Такой юзернейм уже занят' });

  const hash = bcrypt.hashSync(password, 10);
  const info = await db.run(
    'INSERT INTO users (username, password_hash, display_name, phone) VALUES (?, ?, ?, ?)',
    [username, hash, display_name, phone]
  );
  const userId = Number(info.lastInsertRowid);
  const token = newToken();
  await db.run('INSERT INTO user_sessions (token, user_id) VALUES (?, ?)', [token, userId]);
  res.cookie('user_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 60 * 24 * 60 * 60 * 1000 });
  const u = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
  res.json({ ok: true, user: publicUser(u) });
}));

// --- Вход клиента ---
app.post('/api/user-login', wrap(async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const u = await db.get('SELECT * FROM users WHERE username = ? COLLATE NOCASE', [username]);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) {
    return res.status(401).json({ error: 'Неверный юзернейм или пароль' });
  }
  const token = newToken();
  await db.run('INSERT INTO user_sessions (token, user_id) VALUES (?, ?)', [token, u.id]);
  res.cookie('user_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 60 * 24 * 60 * 60 * 1000 });
  res.json({ ok: true, user: publicUser(u) });
}));

app.post('/api/user-logout', wrap(async (req, res) => {
  const token = req.cookies && req.cookies.user_session;
  if (token) await db.run('DELETE FROM user_sessions WHERE token = ?', [token]);
  res.clearCookie('user_session');
  res.json({ ok: true });
}));

app.get('/api/my/orders', requireUser, wrap(async (req, res) => {
  const rows = await db.all('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
  res.json(rows.map((o) => ({ ...serializeOrder(o), token: o.token })));
}));

// --- Вход владельца ---
app.post('/api/login', wrap(async (req, res) => {
  const { password } = req.body || {};
  const hash = await getOwnerHash();
  if (!password || !bcrypt.compareSync(String(password), hash)) {
    return res.status(401).json({ error: 'Неверный пароль' });
  }
  const token = newToken();
  await db.run('INSERT INTO sessions (token) VALUES (?)', [token]);
  res.cookie('owner_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 });
  res.json({ ok: true });
}));

app.post('/api/logout', wrap(async (req, res) => {
  const token = req.cookies && req.cookies.owner_session;
  if (token) await db.run('DELETE FROM sessions WHERE token = ?', [token]);
  res.clearCookie('owner_session');
  res.json({ ok: true });
}));

app.post('/api/change-password', requireOwner, wrap(async (req, res) => {
  const { current, next } = req.body || {};
  const hash = await getOwnerHash();
  if (!bcrypt.compareSync(String(current || ''), hash)) {
    return res.status(400).json({ error: 'Текущий пароль неверен' });
  }
  if (!next || String(next).length < 4) {
    return res.status(400).json({ error: 'Новый пароль слишком короткий (минимум 4 символа)' });
  }
  const newHash = bcrypt.hashSync(String(next), 10);
  await db.run('UPDATE settings SET value = ? WHERE key = ?', [newHash, 'owner_password_hash']);
  res.json({ ok: true });
}));

// --- Настройки уведомлений (Telegram) ---
async function saveSetting(key, value) {
  await db.run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value]
  );
}

app.get('/api/settings', requireOwner, wrap(async (req, res) => {
  const cfg = await notify.telegramConfig();
  res.json({
    telegram_chat_id: cfg.chatId || '',
    telegram_token_set: Boolean(cfg.token),
    telegram_configured: Boolean(cfg.token && cfg.chatId),
  });
}));

app.post('/api/settings', requireOwner, wrap(async (req, res) => {
  const { telegram_bot_token, telegram_chat_id } = req.body || {};
  if (typeof telegram_bot_token === 'string' && telegram_bot_token.trim()) {
    await saveSetting('telegram_bot_token', telegram_bot_token.trim());
  }
  if (typeof telegram_chat_id === 'string') {
    await saveSetting('telegram_chat_id', telegram_chat_id.trim());
  }
  const configured = await notify.isConfigured();
  res.json({ ok: true, telegram_configured: configured });
}));

app.post('/api/settings/telegram-clear', requireOwner, wrap(async (req, res) => {
  await db.run("DELETE FROM settings WHERE key IN ('telegram_bot_token','telegram_chat_id')");
  res.json({ ok: true });
}));

app.post('/api/settings/test-telegram', requireOwner, wrap(async (req, res) => {
  const result = await notify.sendTelegram('✅ Проверка связи: уведомления 3D-Store работают.');
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
}));

// --- Модели ---
async function attachVariants(product) {
  const variants = await db.all(
    'SELECT id, name, extra_price FROM variants WHERE product_id = ? ORDER BY id',
    [product.id]
  );
  return { ...product, variants };
}

app.get('/api/products', wrap(async (req, res) => {
  const owner = await isOwner(req);
  const rows = owner
    ? await db.all('SELECT * FROM products ORDER BY created_at DESC')
    : await db.all('SELECT * FROM products WHERE is_active = 1 ORDER BY created_at DESC');
  const result = await Promise.all(rows.map(attachVariants));
  res.json(result);
}));

app.get('/api/products/:id', wrap(async (req, res) => {
  const p = await db.get('SELECT * FROM products WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Модель не найдена' });
  if (!p.is_active && !(await isOwner(req))) return res.status(404).json({ error: 'Модель не найдена' });
  res.json(await attachVariants(p));
}));

function parseVariants(raw) {
  let list = [];
  try {
    list = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    list = [];
  }
  if (!Array.isArray(list)) list = [];
  return list
    .map((v) => ({ name: String(v.name || '').trim(), extra_price: Number(v.extra_price) || 0 }))
    .filter((v) => v.name);
}

app.post('/api/products', requireOwner, upload.single('image'), wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Укажите название модели' });
  const description = String(req.body.description || '').trim();
  const price = Number(req.body.price) || 0;
  const is_active = req.body.is_active === '0' ? 0 : 1;
  const image = await saveImage(req.file);
  const variants = parseVariants(req.body.variants);

  const info = await db.run(
    'INSERT INTO products (name, description, price, image, is_active) VALUES (?, ?, ?, ?, ?)',
    [name, description, price, image, is_active]
  );
  const productId = Number(info.lastInsertRowid);
  for (const v of variants) {
    await db.run('INSERT INTO variants (product_id, name, extra_price) VALUES (?, ?, ?)', [
      productId,
      v.name,
      v.extra_price,
    ]);
  }
  res.json(await attachVariants(await db.get('SELECT * FROM products WHERE id = ?', [productId])));
}));

app.put('/api/products/:id', requireOwner, upload.single('image'), wrap(async (req, res) => {
  const p = await db.get('SELECT * FROM products WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Модель не найдена' });

  const name = String(req.body.name ?? p.name).trim() || p.name;
  const description = String(req.body.description ?? p.description).trim();
  const price = req.body.price !== undefined ? Number(req.body.price) || 0 : p.price;
  const is_active = req.body.is_active === undefined ? p.is_active : req.body.is_active === '0' ? 0 : 1;

  let image = p.image;
  if (req.file) {
    await deleteImage(p.image);
    image = await saveImage(req.file);
  }

  await db.run('UPDATE products SET name=?, description=?, price=?, image=?, is_active=? WHERE id=?', [
    name,
    description,
    price,
    image,
    is_active,
    p.id,
  ]);

  if (req.body.variants !== undefined) {
    const variants = parseVariants(req.body.variants);
    await db.run('DELETE FROM variants WHERE product_id = ?', [p.id]);
    for (const v of variants) {
      await db.run('INSERT INTO variants (product_id, name, extra_price) VALUES (?, ?, ?)', [
        p.id,
        v.name,
        v.extra_price,
      ]);
    }
  }
  res.json(await attachVariants(await db.get('SELECT * FROM products WHERE id = ?', [p.id])));
}));

app.delete('/api/products/:id', requireOwner, wrap(async (req, res) => {
  const p = await db.get('SELECT * FROM products WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Модель не найдена' });
  await deleteImage(p.image);
  await db.run('DELETE FROM variants WHERE product_id = ?', [p.id]);
  await db.run('DELETE FROM products WHERE id = ?', [p.id]);
  res.json({ ok: true });
}));

// --- Оформление заказа ---
function serializeOrder(o) {
  return {
    id: o.id,
    product_name: o.product_name,
    variant_name: o.variant_name,
    unit_price: o.unit_price,
    quantity: o.quantity,
    total: o.total,
    customer_name: o.customer_name,
    phone: o.phone,
    address: o.address,
    status: o.status,
    created_at: o.created_at,
  };
}

app.post('/api/orders', requireUser, wrap(async (req, res) => {
  const { product_id, variant_id, quantity, customer_name, phone, address, message } = req.body || {};
  const product = await db.get('SELECT * FROM products WHERE id = ? AND is_active = 1', [product_id]);
  if (!product) return res.status(400).json({ error: 'Модель недоступна' });

  const name = String(customer_name || '').trim() || req.user.display_name || req.user.username;

  let variant = null;
  if (variant_id) {
    variant = await db.get('SELECT * FROM variants WHERE id = ? AND product_id = ?', [variant_id, product.id]);
  }
  const qty = Math.max(1, parseInt(quantity, 10) || 1);
  const unit = product.price + (variant ? variant.extra_price : 0);
  const total = unit * qty;
  const token = newToken();

  const info = await db.run(
    `INSERT INTO orders
       (token, user_id, product_id, variant_id, product_name, variant_name, unit_price, quantity, total, customer_name, phone, address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      token,
      req.user.id,
      product.id,
      variant ? variant.id : null,
      product.name,
      variant ? variant.name : '',
      unit,
      qty,
      total,
      name,
      String(phone || '').trim() || req.user.phone || '',
      String(address || '').trim(),
    ]
  );

  const orderId = Number(info.lastInsertRowid);
  const firstMsg = String(message || '').trim();
  if (firstMsg) {
    await db.run('INSERT INTO messages (order_id, sender, body) VALUES (?, ?, ?)', [orderId, 'customer', firstMsg]);
  }

  const fullOrder = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
  notify.notifyNewOrder({ ...fullOrder, username: req.user.username }).catch(() => {});

  res.json({ ok: true, token });
}));

app.get('/api/orders/by-token/:token', wrap(async (req, res) => {
  const o = await db.get('SELECT * FROM orders WHERE token = ?', [req.params.token]);
  if (!o) return res.status(404).json({ error: 'Заказ не найден' });
  res.json(serializeOrder(o));
}));

app.get('/api/orders', requireOwner, wrap(async (req, res) => {
  const rows = await db.all('SELECT * FROM orders ORDER BY created_at DESC');
  const result = [];
  for (const o of rows) {
    const cnt = await db.get("SELECT COUNT(*) AS c FROM messages WHERE order_id = ? AND sender = 'customer'", [o.id]);
    const acc = o.user_id ? await db.get('SELECT username FROM users WHERE id = ?', [o.user_id]) : null;
    result.push({ ...serializeOrder(o), token: o.token, messages_count: cnt ? cnt.c : 0, username: acc ? acc.username : null });
  }
  res.json(result);
}));

app.put('/api/orders/:id/status', requireOwner, wrap(async (req, res) => {
  const allowed = ['new', 'confirmed', 'shipped', 'done', 'cancelled'];
  const status = String(req.body.status || '');
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Недопустимый статус' });
  const o = await db.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!o) return res.status(404).json({ error: 'Заказ не найден' });
  await db.run('UPDATE orders SET status = ? WHERE id = ?', [status, o.id]);
  res.json({ ok: true, status });
}));

// ============ ЧАТ ============
async function getMessages(orderId) {
  return db.all('SELECT id, sender, body, created_at FROM messages WHERE order_id = ? ORDER BY id', [orderId]);
}

app.get('/api/chat/by-token/:token', wrap(async (req, res) => {
  const o = await db.get('SELECT * FROM orders WHERE token = ?', [req.params.token]);
  if (!o) return res.status(404).json({ error: 'Заказ не найден' });
  res.json({ messages: await getMessages(o.id), status: o.status });
}));

app.post('/api/chat/by-token/:token', wrap(async (req, res) => {
  const o = await db.get('SELECT * FROM orders WHERE token = ?', [req.params.token]);
  if (!o) return res.status(404).json({ error: 'Заказ не найден' });
  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Пустое сообщение' });
  await db.run('INSERT INTO messages (order_id, sender, body) VALUES (?, ?, ?)', [o.id, 'customer', body]);
  const acc = o.user_id ? await db.get('SELECT username FROM users WHERE id = ?', [o.user_id]) : null;
  notify.notifyNewMessage({ ...o, username: acc ? acc.username : null }, body).catch(() => {});
  res.json({ messages: await getMessages(o.id) });
}));

app.get('/api/chat/order/:id', requireOwner, wrap(async (req, res) => {
  const o = await db.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!o) return res.status(404).json({ error: 'Заказ не найден' });
  res.json({ messages: await getMessages(o.id), status: o.status });
}));

app.post('/api/chat/order/:id', requireOwner, wrap(async (req, res) => {
  const o = await db.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!o) return res.status(404).json({ error: 'Заказ не найден' });
  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Пустое сообщение' });
  await db.run('INSERT INTO messages (order_id, sender, body) VALUES (?, ?, ?)', [o.id, 'owner', body]);
  res.json({ messages: await getMessages(o.id) });
}));

// ------- Статика -------
app.use(express.static(path.join(ROOT, 'public')));
app.get('/admin', (req, res) => res.sendFile(path.join(ROOT, 'public', 'admin.html')));
app.get('/order', (req, res) => res.sendFile(path.join(ROOT, 'public', 'order.html')));

// Обработчик ошибок
app.use((err, req, res, next) => {
  console.error(err);
  res.status(400).json({ error: err.message || 'Ошибка сервера' });
});

async function main() {
  await db.init();
  await ensureOwnerPassword();
  app.listen(PORT, () => console.log(`[3D-Store] Сервер запущен: http://localhost:${PORT}`));
}

main().catch((e) => {
  console.error('Не удалось запустить сервер:', e);
  process.exit(1);
});
