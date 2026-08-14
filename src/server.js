'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const multer = require('multer');

const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ------- Первичная настройка: пароль владельца -------
// Пароль берётся из переменной окружения OWNER_PASSWORD, иначе по умолчанию "admin".
// При первом запуске хэш пароля сохраняется в БД. Сменить пароль можно в админке.
function ensureOwnerPassword() {
  const existing = db.prepare('SELECT value FROM settings WHERE key = ?').get('owner_password_hash');
  if (!existing) {
    const initial = process.env.OWNER_PASSWORD || 'admin';
    const hash = bcrypt.hashSync(initial, 10);
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('owner_password_hash', hash);
    console.log('[3D-Store] Пароль владельца установлен. По умолчанию: "admin" (смените его в админке!).');
  }
}
ensureOwnerPassword();

function getOwnerHash() {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get('owner_password_hash').value;
}

// ------- Загрузка изображений -------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
    const safe = crypto.randomBytes(12).toString('hex');
    cb(null, `${safe}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 МБ
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Разрешены только изображения'));
  },
});

// ------- Аутентификация владельца -------
function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function isOwner(req) {
  const token = req.cookies && req.cookies.owner_session;
  if (!token) return false;
  const row = db.prepare('SELECT token FROM sessions WHERE token = ?').get(token);
  return !!row;
}

function requireOwner(req, res, next) {
  if (isOwner(req)) return next();
  return res.status(401).json({ error: 'Требуется вход владельца' });
}

// Текущий клиент (аккаунт)
function currentUser(req) {
  const token = req.cookies && req.cookies.user_session;
  if (!token) return null;
  const row = db
    .prepare(
      'SELECT u.* FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'
    )
    .get(token);
  return row || null;
}

function requireUser(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Войдите в аккаунт' });
  req.user = u;
  next();
}

function publicUser(u) {
  return { id: u.id, username: u.username, display_name: u.display_name || u.username, phone: u.phone || '' };
}

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,24}$/;

// ============ API ============

// --- Статус текущего пользователя ---
app.get('/api/me', (req, res) => {
  const u = currentUser(req);
  res.json({ owner: isOwner(req), user: u ? publicUser(u) : null });
});

// --- Регистрация клиента (юзернейм + пароль, без email) ---
app.post('/api/register', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const display_name = String(req.body.display_name || '').trim();
  const phone = String(req.body.phone || '').trim();

  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({
      error: 'Юзернейм: 3–24 символа, латиница, цифры, . _ -',
    });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: 'Пароль слишком короткий (минимум 4 символа)' });
  }
  const exists = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (exists) return res.status(409).json({ error: 'Такой юзернейм уже занят' });

  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare('INSERT INTO users (username, password_hash, display_name, phone) VALUES (?, ?, ?, ?)')
    .run(username, hash, display_name, phone);

  const token = newToken();
  db.prepare('INSERT INTO user_sessions (token, user_id) VALUES (?, ?)').run(token, info.lastInsertRowid);
  res.cookie('user_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 60 * 24 * 60 * 60 * 1000 });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.json({ ok: true, user: publicUser(u) });
});

// --- Вход клиента ---
app.post('/api/user-login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const u = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) {
    return res.status(401).json({ error: 'Неверный юзернейм или пароль' });
  }
  const token = newToken();
  db.prepare('INSERT INTO user_sessions (token, user_id) VALUES (?, ?)').run(token, u.id);
  res.cookie('user_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 60 * 24 * 60 * 60 * 1000 });
  res.json({ ok: true, user: publicUser(u) });
});

// --- Выход клиента ---
app.post('/api/user-logout', (req, res) => {
  const token = req.cookies && req.cookies.user_session;
  if (token) db.prepare('DELETE FROM user_sessions WHERE token = ?').run(token);
  res.clearCookie('user_session');
  res.json({ ok: true });
});

// --- Заказы текущего клиента ---
app.get('/api/my/orders', requireUser, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC')
    .all(req.user.id);
  res.json(rows.map((o) => ({ ...serializeOrder(o), token: o.token })));
});

// --- Вход владельца ---
app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (!password || !bcrypt.compareSync(String(password), getOwnerHash())) {
    return res.status(401).json({ error: 'Неверный пароль' });
  }
  const token = newToken();
  db.prepare('INSERT INTO sessions (token) VALUES (?)').run(token);
  res.cookie('owner_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 дней
  });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies && req.cookies.owner_session;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.clearCookie('owner_session');
  res.json({ ok: true });
});

// --- Смена пароля ---
app.post('/api/change-password', requireOwner, (req, res) => {
  const { current, next } = req.body || {};
  if (!bcrypt.compareSync(String(current || ''), getOwnerHash())) {
    return res.status(400).json({ error: 'Текущий пароль неверен' });
  }
  if (!next || String(next).length < 4) {
    return res.status(400).json({ error: 'Новый пароль слишком короткий (минимум 4 символа)' });
  }
  const hash = bcrypt.hashSync(String(next), 10);
  db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(hash, 'owner_password_hash');
  res.json({ ok: true });
});

// --- Публичный список моделей ---
function attachVariants(product) {
  const variants = db
    .prepare('SELECT id, name, extra_price FROM variants WHERE product_id = ? ORDER BY id')
    .all(product.id);
  return { ...product, variants };
}

app.get('/api/products', (req, res) => {
  const all = isOwner(req);
  const rows = all
    ? db.prepare('SELECT * FROM products ORDER BY created_at DESC').all()
    : db.prepare('SELECT * FROM products WHERE is_active = 1 ORDER BY created_at DESC').all();
  res.json(rows.map(attachVariants));
});

app.get('/api/products/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Модель не найдена' });
  if (!p.is_active && !isOwner(req)) return res.status(404).json({ error: 'Модель не найдена' });
  res.json(attachVariants(p));
});

// --- Создание/редактирование модели (владелец) ---
function parseVariants(raw) {
  let list = [];
  try {
    list = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    list = [];
  }
  if (!Array.isArray(list)) list = [];
  return list
    .map((v) => ({
      name: String(v.name || '').trim(),
      extra_price: Number(v.extra_price) || 0,
    }))
    .filter((v) => v.name);
}

app.post('/api/products', requireOwner, upload.single('image'), (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Укажите название модели' });
  const description = String(req.body.description || '').trim();
  const price = Number(req.body.price) || 0;
  const is_active = req.body.is_active === '0' ? 0 : 1;
  const image = req.file ? req.file.filename : '';
  const variants = parseVariants(req.body.variants);

  const info = db
    .prepare('INSERT INTO products (name, description, price, image, is_active) VALUES (?, ?, ?, ?, ?)')
    .run(name, description, price, image, is_active);
  const productId = info.lastInsertRowid;
  const insV = db.prepare('INSERT INTO variants (product_id, name, extra_price) VALUES (?, ?, ?)');
  for (const v of variants) insV.run(productId, v.name, v.extra_price);

  res.json(attachVariants(db.prepare('SELECT * FROM products WHERE id = ?').get(productId)));
});

app.put('/api/products/:id', requireOwner, upload.single('image'), (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Модель не найдена' });

  const name = String(req.body.name ?? p.name).trim() || p.name;
  const description = String(req.body.description ?? p.description).trim();
  const price = req.body.price !== undefined ? Number(req.body.price) || 0 : p.price;
  const is_active = req.body.is_active === undefined ? p.is_active : req.body.is_active === '0' ? 0 : 1;

  let image = p.image;
  if (req.file) {
    // удалить старое изображение
    if (p.image) {
      const old = path.join(UPLOAD_DIR, p.image);
      if (fs.existsSync(old)) fs.unlinkSync(old);
    }
    image = req.file.filename;
  }

  db.prepare('UPDATE products SET name=?, description=?, price=?, image=?, is_active=? WHERE id=?')
    .run(name, description, price, image, is_active, p.id);

  if (req.body.variants !== undefined) {
    const variants = parseVariants(req.body.variants);
    db.prepare('DELETE FROM variants WHERE product_id = ?').run(p.id);
    const insV = db.prepare('INSERT INTO variants (product_id, name, extra_price) VALUES (?, ?, ?)');
    for (const v of variants) insV.run(p.id, v.name, v.extra_price);
  }

  res.json(attachVariants(db.prepare('SELECT * FROM products WHERE id = ?').get(p.id)));
});

app.delete('/api/products/:id', requireOwner, (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Модель не найдена' });
  if (p.image) {
    const img = path.join(UPLOAD_DIR, p.image);
    if (fs.existsSync(img)) fs.unlinkSync(img);
  }
  db.prepare('DELETE FROM products WHERE id = ?').run(p.id);
  res.json({ ok: true });
});

// --- Оформление заказа (только для авторизованного клиента) ---
app.post('/api/orders', requireUser, (req, res) => {
  const { product_id, variant_id, quantity, customer_name, phone, address, message } = req.body || {};
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND is_active = 1').get(product_id);
  if (!product) return res.status(400).json({ error: 'Модель недоступна' });

  const name = String(customer_name || '').trim() || req.user.display_name || req.user.username;

  let variant = null;
  if (variant_id) {
    variant = db.prepare('SELECT * FROM variants WHERE id = ? AND product_id = ?').get(variant_id, product.id);
  }
  const qty = Math.max(1, parseInt(quantity, 10) || 1);
  const unit = product.price + (variant ? variant.extra_price : 0);
  const total = unit * qty;
  const token = newToken();

  const info = db
    .prepare(
      `INSERT INTO orders
       (token, user_id, product_id, variant_id, product_name, variant_name, unit_price, quantity, total, customer_name, phone, address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
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
      String(address || '').trim()
    );

  const orderId = info.lastInsertRowid;
  const firstMsg = String(message || '').trim();
  if (firstMsg) {
    db.prepare('INSERT INTO messages (order_id, sender, body) VALUES (?, ?, ?)').run(orderId, 'customer', firstMsg);
  }

  res.json({ ok: true, token });
});

// --- Просмотр заказа клиентом по токену ---
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

app.get('/api/orders/by-token/:token', (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE token = ?').get(req.params.token);
  if (!o) return res.status(404).json({ error: 'Заказ не найден' });
  res.json(serializeOrder(o));
});

// --- Список заказов (владелец) ---
app.get('/api/orders', requireOwner, (req, res) => {
  const rows = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  const result = rows.map((o) => {
    const unread = db
      .prepare("SELECT COUNT(*) AS c FROM messages WHERE order_id = ? AND sender = 'customer'")
      .get(o.id).c;
    const acc = o.user_id ? db.prepare('SELECT username FROM users WHERE id = ?').get(o.user_id) : null;
    return { ...serializeOrder(o), token: o.token, messages_count: unread, username: acc ? acc.username : null };
  });
  res.json(result);
});

app.put('/api/orders/:id/status', requireOwner, (req, res) => {
  const allowed = ['new', 'confirmed', 'shipped', 'done', 'cancelled'];
  const status = String(req.body.status || '');
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Недопустимый статус' });
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Заказ не найден' });
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, o.id);
  res.json({ ok: true, status });
});

// ============ ЧАТ ============
// Клиент обращается по токену, владелец — по id заказа (с авторизацией).

function loadOrderForChat(req) {
  if (req.params.token) {
    const o = db.prepare('SELECT * FROM orders WHERE token = ?').get(req.params.token);
    return o ? { order: o, sender: 'customer' } : null;
  }
  if (req.params.id) {
    if (!isOwner(req)) return { forbidden: true };
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    return o ? { order: o, sender: 'owner' } : null;
  }
  return null;
}

function getMessages(orderId) {
  return db
    .prepare('SELECT id, sender, body, created_at FROM messages WHERE order_id = ? ORDER BY id')
    .all(orderId);
}

// Клиентский чат
app.get('/api/chat/by-token/:token', (req, res) => {
  const ctx = loadOrderForChat(req);
  if (!ctx || !ctx.order) return res.status(404).json({ error: 'Заказ не найден' });
  res.json({ messages: getMessages(ctx.order.id), status: ctx.order.status });
});

app.post('/api/chat/by-token/:token', (req, res) => {
  const ctx = loadOrderForChat(req);
  if (!ctx || !ctx.order) return res.status(404).json({ error: 'Заказ не найден' });
  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Пустое сообщение' });
  db.prepare('INSERT INTO messages (order_id, sender, body) VALUES (?, ?, ?)').run(ctx.order.id, 'customer', body);
  res.json({ messages: getMessages(ctx.order.id) });
});

// Чат владельца
app.get('/api/chat/order/:id', requireOwner, (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Заказ не найден' });
  res.json({ messages: getMessages(o.id), status: o.status });
});

app.post('/api/chat/order/:id', requireOwner, (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Заказ не найден' });
  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Пустое сообщение' });
  db.prepare('INSERT INTO messages (order_id, sender, body) VALUES (?, ?, ?)').run(o.id, 'owner', body);
  res.json({ messages: getMessages(o.id) });
});

// ------- Статика -------
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(ROOT, 'public')));

// SPA-подобные маршруты -> отдаём соответствующие страницы
app.get('/admin', (req, res) => res.sendFile(path.join(ROOT, 'public', 'admin.html')));
app.get('/order', (req, res) => res.sendFile(path.join(ROOT, 'public', 'order.html')));

// Обработка ошибок multer и прочих
app.use((err, req, res, next) => {
  console.error(err);
  res.status(400).json({ error: err.message || 'Ошибка сервера' });
});

app.listen(PORT, () => {
  console.log(`[3D-Store] Сервер запущен: http://localhost:${PORT}`);
});
