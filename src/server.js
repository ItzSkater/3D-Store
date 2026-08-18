'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const sharp = require('sharp');

const db = require('./db');
const notify = require('./notify');
const bot = require('./bot');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Оборачиваем async-обработчики, чтобы ошибки уходили в общий обработчик.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ------- Загрузка изображений (в память, затем в БД) -------
const VIDEO_MIMES = ['video/mp4', 'video/quicktime', 'video/webm'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 МБ (видео Live Photo тяжелее фото)
  fileFilter: (req, file, cb) => {
    const m = String(file.mimetype || '').toLowerCase();
    if (/^image\//.test(m) || VIDEO_MIMES.includes(m)) cb(null, true);
    else cb(new Error('Разрешены изображения, GIF и короткие видео'));
  },
});

function isVideoMime(mime) {
  return VIDEO_MIMES.includes(String(mime || '').toLowerCase());
}

// Приводим фото к WebP: поворот по EXIF (телефонные снимки), ужатие до
// 1600px по большей стороне, качество 82. Экономит трафик и ускоряет
// загрузку на телефонах.
async function toWebp(buffer, { square = false } = {}) {
  // Анимированные GIF конвертируем со всеми кадрами — получится живая
  // картинка в WebP. Поворот по EXIF для анимаций не применяем: он ломает
  // покадровую раскладку.
  let animated = false;
  try {
    const meta = await sharp(buffer, { failOn: 'none' }).metadata();
    animated = (meta.pages || 1) > 1;
  } catch {
    animated = false;
  }

  const img = sharp(buffer, { failOn: 'none', animated });
  if (!animated) img.rotate();

  if (square) {
    // Кадрируем по центру значимой части снимка
    img.resize({ width: 1200, height: 1200, fit: 'cover', position: animated ? 'centre' : 'attention' });
  } else {
    img.resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true });
  }
  return img.webp({ quality: 82 }).toBuffer();
}

async function saveImage(file, opts = {}) {
  if (!file) return '';
  let data = file.buffer;
  let mime = file.mimetype || 'image/jpeg';

  if (isVideoMime(mime)) {
    // Видео (в том числе ролик из Live Photo) храним как есть — перекодировать
    // нечем, а браузеры и так проигрывают mp4/mov.
    const res = await db.run('INSERT INTO images (mime, data) VALUES (?, ?)', [mime, data]);
    return String(Number(res.lastInsertRowid));
  }

  try {
    data = await toWebp(file.buffer, opts);
    mime = 'image/webp';
  } catch (e) {
    // Если конвертация не удалась (битый файл и т.п.) — сохраняем как есть
    console.warn('[3D-Store] Не удалось сконвертировать фото в WebP:', e.message);
  }
  const res = await db.run('INSERT INTO images (mime, data) VALUES (?, ?)', [mime, data]);
  return String(Number(res.lastInsertRowid));
}

// Фоновая конвертация уже загруженных фото в WebP (разово при старте).
async function migrateImagesToWebp() {
  const rows = await db.all(
    "SELECT id FROM images WHERE mime != 'image/webp' AND mime NOT LIKE 'video/%'"
  );
  if (!rows.length) return;
  console.log(`[3D-Store] Конвертирую ${rows.length} старых фото в WebP…`);
  let done = 0;
  for (const r of rows) {
    try {
      const img = await db.get('SELECT data FROM images WHERE id = ?', [r.id]);
      if (!img) continue;
      const buf = Buffer.isBuffer(img.data) ? img.data : Buffer.from(img.data);
      const webp = await toWebp(buf);
      await db.run("UPDATE images SET data = ?, mime = 'image/webp' WHERE id = ?", [webp, r.id]);
      done++;
    } catch (e) {
      console.warn(`[3D-Store] Фото #${r.id} не сконвертировано: ${e.message}`);
    }
  }
  console.log(`[3D-Store] Конвертация завершена: ${done}/${rows.length} фото теперь в WebP.`);
}
async function deleteImage(imageId) {
  if (!imageId) return;
  const id = parseInt(imageId, 10);
  if (id) await db.run('DELETE FROM images WHERE id = ?', [id]);
}

// ------- Первичная настройка: пароль владельца -------
async function ensureOwnerPassword() {
  // Аварийный сброс пароля: задайте переменную окружения RESET_OWNER_PASSWORD
  // с новым паролем — при запуске он перезапишет текущий. После входа
  // обязательно удалите эту переменную (иначе пароль будет сбрасываться
  // при каждом перезапуске).
  const reset = process.env.RESET_OWNER_PASSWORD;
  if (reset && String(reset).trim()) {
    const hash = bcrypt.hashSync(String(reset).trim(), 10);
    await db.run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ['owner_password_hash', hash]
    );
    console.log('[3D-Store] Пароль владельца СБРОШЕН через RESET_OWNER_PASSWORD. Удалите эту переменную окружения.');
    return;
  }

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
  const rows = await db.all(
    'SELECT o.*, v.color AS variant_color FROM orders o LEFT JOIN variants v ON v.id = o.variant_id WHERE o.user_id = ? ORDER BY o.created_at DESC',
    [req.user.id]
  );
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
    'SELECT id, name, extra_price, color, stock FROM variants WHERE product_id = ? ORDER BY id',
    [product.id]
  );
  // Тянем mime, чтобы фронт знал, что рисовать: картинку или видео
  const imgRows = await db.all(
    `SELECT pi.image_id, i.mime
       FROM product_images pi LEFT JOIN images i ON i.id = pi.image_id
      WHERE pi.product_id = ? ORDER BY pi.pos, pi.id`,
    [product.id]
  );
  let images = imgRows.map((r) => ({
    id: String(r.image_id),
    kind: isVideoMime(r.mime) ? 'video' : 'image',
  }));
  // Старые записи: одно фото лежало прямо в products.image
  if (!images.length && product.image) images = [{ id: String(product.image), kind: 'image' }];
  return { ...product, variants, images };
}

// Синхронизирует обложку (products.image) с первым фото галереи —
// её используют старые пути (бот, карточки).
async function syncCover(productId) {
  // Обложка — первое именно ИЗОБРАЖЕНИЕ: его показывают карточки и шлёт бот
  const first = await db.get(
    `SELECT pi.image_id
       FROM product_images pi JOIN images i ON i.id = pi.image_id
      WHERE pi.product_id = ? AND i.mime NOT LIKE 'video/%'
      ORDER BY pi.pos, pi.id LIMIT 1`,
    [productId]
  );
  await db.run('UPDATE products SET image = ? WHERE id = ?', [first ? String(first.image_id) : '', productId]);
}

const MAX_IMAGES = 10;

// Скидка клиенту на модель: действует, если он раньше уже покупал
// «модель-триггер» (заказ не отменён). Берём лучшую из подходящих.
async function discountFor(userId, productId) {
  if (!userId || !productId) return 0;
  const row = await db.get(
    `SELECT MAX(d.percent) AS p
       FROM discounts d
      WHERE d.target_product_id = ?
        AND EXISTS (
          SELECT 1 FROM orders o
           WHERE o.user_id = ?
             AND o.product_id = d.trigger_product_id
             AND o.status != 'cancelled'
        )`,
    [productId, userId]
  );
  const p = row && row.p ? Number(row.p) : 0;
  return Math.min(Math.max(Math.round(p), 0), 100);
}

// Цена со скидкой
function applyDiscount(price, percent) {
  if (!percent) return price;
  return Math.round(price * (100 - percent)) / 100;
}

// Нормализация цвета варианта: {"c":["#hex",...],"m":bool} или пусто.
// До 4 цветов (2+ = градиент), m — металлик.
function normColor(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return '';
    try {
      obj = JSON.parse(raw);
    } catch {
      return '';
    }
  }
  if (!obj || typeof obj !== 'object') return '';
  const colors = (Array.isArray(obj.c) ? obj.c : [])
    .map((x) => String(x).trim())
    .filter((x) => /^#[0-9a-fA-F]{6}$/.test(x))
    .slice(0, 4);
  if (!colors.length) return '';
  return JSON.stringify({ c: colors, m: !!obj.m });
}

app.get('/api/products', wrap(async (req, res) => {
  const owner = await isOwner(req);
  const rows = owner
    ? await db.all('SELECT * FROM products ORDER BY created_at DESC')
    : await db.all('SELECT * FROM products WHERE is_active = 1 ORDER BY created_at DESC');
  const result = await Promise.all(rows.map(attachVariants));
  // Персональные скидки: считаем для вошедшего клиента
  const u = await currentUser(req);
  if (u) {
    for (const p of result) p.discount = await discountFor(u.id, p.id);
  }
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
    .map((v) => {
      // Остаток: пустая строка/null = не отслеживать, иначе целое >= 0
      let stock = null;
      if (v.stock !== undefined && v.stock !== null && String(v.stock).trim() !== '') {
        stock = Math.max(0, parseInt(v.stock, 10) || 0);
      }
      return {
        name: String(v.name || '').trim(),
        extra_price: Number(v.extra_price) || 0,
        color: normColor(v.color),
        stock,
      };
    })
    .filter((v) => v.name);
}

async function insertVariants(productId, variants) {
  for (const v of variants) {
    await db.run(
      'INSERT INTO variants (product_id, name, extra_price, color, stock) VALUES (?, ?, ?, ?, ?)',
      [productId, v.name, v.extra_price, v.color, v.stock]
    );
  }
}

// Легаси-миграция: если фото модели лежит только в products.image,
// переносим его в галерею, чтобы дальше работать единообразно.
async function ensureGallery(p) {
  const cnt = await db.get('SELECT COUNT(*) AS c FROM product_images WHERE product_id = ?', [p.id]);
  if (!cnt.c && p.image) {
    await db.run('INSERT INTO product_images (product_id, image_id, pos) VALUES (?, ?, 0)', [
      p.id,
      parseInt(p.image, 10),
    ]);
  }
}

app.post('/api/products', requireOwner, upload.array('images', MAX_IMAGES), wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Укажите название модели' });
  const description = String(req.body.description || '').trim();
  const price = Number(req.body.price) || 0;
  const is_active = req.body.is_active === '0' ? 0 : 1;
  const variants = parseVariants(req.body.variants);

  const info = await db.run(
    'INSERT INTO products (name, description, price, image, is_active) VALUES (?, ?, ?, ?, ?)',
    [name, description, price, '', is_active]
  );
  const productId = Number(info.lastInsertRowid);

  const files = (req.files || []).slice(0, MAX_IMAGES);
  for (let i = 0; i < files.length; i++) {
    const imgId = await saveImage(files[i], { square: req.body.square === '1' });
    await db.run('INSERT INTO product_images (product_id, image_id, pos) VALUES (?, ?, ?)', [
      productId,
      parseInt(imgId, 10),
      i,
    ]);
  }
  await syncCover(productId);
  await insertVariants(productId, variants);

  res.json(await attachVariants(await db.get('SELECT * FROM products WHERE id = ?', [productId])));
}));

app.put('/api/products/:id', requireOwner, upload.array('images', MAX_IMAGES), wrap(async (req, res) => {
  const p = await db.get('SELECT * FROM products WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Модель не найдена' });
  await ensureGallery(p);

  const name = String(req.body.name ?? p.name).trim() || p.name;
  const description = String(req.body.description ?? p.description).trim();
  const price = req.body.price !== undefined ? Number(req.body.price) || 0 : p.price;
  const is_active = req.body.is_active === undefined ? p.is_active : req.body.is_active === '0' ? 0 : 1;

  await db.run('UPDATE products SET name=?, description=?, price=?, is_active=? WHERE id=?', [
    name,
    description,
    price,
    is_active,
    p.id,
  ]);

  // Удаление отмеченных фото
  let removeIds = [];
  try {
    removeIds = JSON.parse(req.body.remove_images || '[]');
  } catch {
    removeIds = [];
  }
  for (const rid of (Array.isArray(removeIds) ? removeIds : []).map((x) => parseInt(x, 10)).filter(Boolean)) {
    await db.run('DELETE FROM product_images WHERE product_id = ? AND image_id = ?', [p.id, rid]);
    await deleteImage(rid);
  }

  // Добавление новых фото (не больше MAX_IMAGES суммарно)
  const cur = await db.get('SELECT COUNT(*) AS c, COALESCE(MAX(pos), -1) AS mx FROM product_images WHERE product_id = ?', [p.id]);
  let free = MAX_IMAGES - cur.c;
  let pos = cur.mx + 1;
  for (const f of (req.files || [])) {
    if (free <= 0) break;
    const imgId = await saveImage(f, { square: req.body.square === '1' });
    await db.run('INSERT INTO product_images (product_id, image_id, pos) VALUES (?, ?, ?)', [
      p.id,
      parseInt(imgId, 10),
      pos++,
    ]);
    free--;
  }
  await syncCover(p.id);

  if (req.body.variants !== undefined) {
    const variants = parseVariants(req.body.variants);
    await db.run('DELETE FROM variants WHERE product_id = ?', [p.id]);
    await insertVariants(p.id, variants);
  }
  res.json(await attachVariants(await db.get('SELECT * FROM products WHERE id = ?', [p.id])));
}));

// --- Скидки (владелец) ---
app.get('/api/discounts', requireOwner, wrap(async (req, res) => {
  const rows = await db.all(
    `SELECT d.*, tp.name AS trigger_name, gp.name AS target_name
       FROM discounts d
       LEFT JOIN products tp ON tp.id = d.trigger_product_id
       LEFT JOIN products gp ON gp.id = d.target_product_id
      ORDER BY d.id DESC`
  );
  res.json(rows);
}));

app.post('/api/discounts', requireOwner, wrap(async (req, res) => {
  const trigger = parseInt(req.body.trigger_product_id, 10);
  const target = parseInt(req.body.target_product_id, 10);
  const percent = Math.round(Number(req.body.percent));
  if (!trigger || !target) return res.status(400).json({ error: 'Выберите обе модели' });
  if (trigger === target) return res.status(400).json({ error: 'Модели должны быть разными' });
  if (!(percent > 0 && percent <= 100)) return res.status(400).json({ error: 'Процент должен быть от 1 до 100' });

  const a = await db.get('SELECT id FROM products WHERE id = ?', [trigger]);
  const b = await db.get('SELECT id FROM products WHERE id = ?', [target]);
  if (!a || !b) return res.status(400).json({ error: 'Модель не найдена' });

  const dup = await db.get(
    'SELECT id FROM discounts WHERE trigger_product_id = ? AND target_product_id = ?',
    [trigger, target]
  );
  if (dup) {
    await db.run('UPDATE discounts SET percent = ? WHERE id = ?', [percent, dup.id]);
    return res.json({ ok: true, id: dup.id, updated: true });
  }
  const info = await db.run(
    'INSERT INTO discounts (trigger_product_id, target_product_id, percent) VALUES (?, ?, ?)',
    [trigger, target, percent]
  );
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
}));

app.delete('/api/discounts/:id', requireOwner, wrap(async (req, res) => {
  await db.run('DELETE FROM discounts WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

// Обрезка фото модели. Координаты — доли от 0 до 1 относительно снимка.
// Создаём новое изображение и подменяем им старое в галерее: URL меняется,
// поэтому браузер гарантированно покажет обрезанный вариант, а не кэш.
app.post('/api/products/:pid/images/:imgId/crop', requireOwner, wrap(async (req, res) => {
  const p = await db.get('SELECT * FROM products WHERE id = ?', [req.params.pid]);
  if (!p) return res.status(404).json({ error: 'Модель не найдена' });
  await ensureGallery(p);

  const oldId = parseInt(req.params.imgId, 10);
  const link = await db.get('SELECT * FROM product_images WHERE product_id = ? AND image_id = ?', [p.id, oldId]);
  if (!link) return res.status(404).json({ error: 'Фото не найдено' });

  const src = await db.get('SELECT data, mime FROM images WHERE id = ?', [oldId]);
  if (!src) return res.status(404).json({ error: 'Фото не найдено' });
  if (isVideoMime(src.mime)) return res.status(400).json({ error: 'Видео обрезать нельзя' });

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : NaN);
  let { x, y, w, h } = { x: num(req.body.x), y: num(req.body.y), w: num(req.body.w), h: num(req.body.h) };
  if ([x, y, w, h].some((v) => Number.isNaN(v)) || w <= 0 || h <= 0) {
    return res.status(400).json({ error: 'Неверная область обрезки' });
  }

  const buf = Buffer.isBuffer(src.data) ? src.data : Buffer.from(src.data);
  let out;
  try {
    // Сначала применяем поворот из EXIF, чтобы координаты совпали с тем,
    // что владелец видел в браузере.
    const upright = await sharp(buf, { failOn: 'none' }).rotate().toBuffer();
    const meta = await sharp(upright).metadata();
    const W = meta.width || 0;
    const H = meta.height || 0;
    if (!W || !H) throw new Error('не удалось прочитать размеры');

    const left = Math.min(Math.max(Math.round(x * W), 0), W - 1);
    const top = Math.min(Math.max(Math.round(y * H), 0), H - 1);
    const width = Math.max(1, Math.min(Math.round(w * W), W - left));
    const height = Math.max(1, Math.min(Math.round(h * H), H - top));

    out = await sharp(upright)
      .extract({ left, top, width, height })
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
  } catch (e) {
    return res.status(400).json({ error: 'Не удалось обрезать фото: ' + e.message });
  }

  const ins = await db.run('INSERT INTO images (mime, data) VALUES (?, ?)', ['image/webp', out]);
  const newId = Number(ins.lastInsertRowid);
  await db.run('UPDATE product_images SET image_id = ? WHERE product_id = ? AND image_id = ?', [newId, p.id, oldId]);
  await deleteImage(oldId);
  await syncCover(p.id);

  res.json({ ok: true, image_id: String(newId) });
}));

app.delete('/api/products/:id', requireOwner, wrap(async (req, res) => {
  const p = await db.get('SELECT * FROM products WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Модель не найдена' });
  const imgs = await db.all('SELECT image_id FROM product_images WHERE product_id = ?', [p.id]);
  for (const r of imgs) await deleteImage(r.image_id);
  if (p.image && !imgs.some((r) => String(r.image_id) === String(p.image))) await deleteImage(p.image);
  await db.run('DELETE FROM product_images WHERE product_id = ?', [p.id]);
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
    variant_color: o.variant_color || null,
    discount_percent: o.discount_percent || 0,
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
  // Персональная скидка: считаем на сервере, значению с клиента не доверяем
  const percent = await discountFor(req.user.id, product.id);

  // Проверка остатка (если он отслеживается у варианта)
  if (variant && variant.stock !== null && variant.stock !== undefined) {
    if (variant.stock <= 0) return res.status(400).json({ error: 'Этого цвета нет в наличии' });
    if (qty > variant.stock) {
      return res.status(400).json({ error: `В наличии только ${variant.stock} шт этого цвета` });
    }
  }
  const unit = applyDiscount(product.price + (variant ? variant.extra_price : 0), percent);
  const total = unit * qty;
  const token = newToken();

  const info = await db.run(
    `INSERT INTO orders
       (token, user_id, product_id, variant_id, product_name, variant_name, unit_price, quantity, total, customer_name, phone, address, discount_percent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      percent,
    ]
  );

  const orderId = Number(info.lastInsertRowid);

  // Списываем остаток
  if (variant && variant.stock !== null && variant.stock !== undefined) {
    await db.run('UPDATE variants SET stock = MAX(stock - ?, 0) WHERE id = ? AND stock IS NOT NULL', [qty, variant.id]);
  }

  const firstMsg = String(message || '').trim();
  if (firstMsg) {
    await db.run('INSERT INTO messages (order_id, sender, body) VALUES (?, ?, ?)', [orderId, 'customer', firstMsg]);
  }

  const fullOrder = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
  notify.notifyNewOrder({ ...fullOrder, username: req.user.username }).catch(() => {});

  res.json({ ok: true, token });
}));

app.get('/api/orders/by-token/:token', wrap(async (req, res) => {
  const o = await db.get(
    'SELECT o.*, v.color AS variant_color FROM orders o LEFT JOIN variants v ON v.id = o.variant_id WHERE o.token = ?',
    [req.params.token]
  );
  if (!o) return res.status(404).json({ error: 'Заказ не найден' });
  res.json(serializeOrder(o));
}));

app.get('/api/orders', requireOwner, wrap(async (req, res) => {
  const rows = await db.all(
    'SELECT o.*, v.color AS variant_color FROM orders o LEFT JOIN variants v ON v.id = o.variant_id ORDER BY o.created_at DESC'
  );
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
  // Отмена возвращает остаток на склад, «раз-отмена» — списывает обратно
  if (o.variant_id && status === 'cancelled' && o.status !== 'cancelled') {
    await db.run('UPDATE variants SET stock = stock + ? WHERE id = ? AND stock IS NOT NULL', [o.quantity, o.variant_id]);
  } else if (o.variant_id && o.status === 'cancelled' && status !== 'cancelled') {
    await db.run('UPDATE variants SET stock = MAX(stock - ?, 0) WHERE id = ? AND stock IS NOT NULL', [o.quantity, o.variant_id]);
  }
  notify.notifyCustomerStatus({ ...o, status }, status).catch(() => {});
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
  notify.notifyCustomerMessage(o, body).catch(() => {});
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
  // Telegram-бот (магазин для клиентов + команды владельца).
  // Запускается, только если задан токен; сам дождётся его, если добавят позже.
  bot.startBot();
  // Разовая фоновая конвертация старых фото в WebP — не блокирует запуск.
  migrateImagesToWebp().catch((e) => console.warn('[3D-Store] Миграция фото:', e.message));
}

main().catch((e) => {
  console.error('Не удалось запустить сервер:', e);
  process.exit(1);
});
