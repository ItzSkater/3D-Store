'use strict';

// Telegram-бот: магазин для клиентов + команды владельца.
// Один бот на всех: владелец узнаётся по TELEGRAM_CHAT_ID, остальные — клиенты.
// Работает через long polling, публичный адрес сайта не нужен.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');
const tg = require('./tg');
const { esc, money } = tg;

const STATUS = {
  new: 'Новый',
  confirmed: 'Подтверждён',
  shipped: 'Отправлен',
  done: 'Выполнен',
  cancelled: 'Отменён',
};

let running = false;
let stopped = false;
let offset = 0;

// ---------------- состояние диалога ----------------
async function getState(chatId) {
  const row = await db.get('SELECT state, data FROM tg_state WHERE chat_id = ?', [String(chatId)]);
  if (!row) return { state: '', data: {} };
  let data = {};
  try {
    data = JSON.parse(row.data || '{}');
  } catch {
    data = {};
  }
  return { state: row.state || '', data };
}

async function setState(chatId, state, data = {}) {
  await db.run(
    `INSERT INTO tg_state (chat_id, state, data, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(chat_id) DO UPDATE SET state = excluded.state, data = excluded.data, updated_at = excluded.updated_at`,
    [String(chatId), state, JSON.stringify(data || {})]
  );
}

async function clearState(chatId) {
  await setState(chatId, '', {});
}

// ---------------- аккаунт клиента ----------------
// Клиенту из Telegram аккаунт создаётся автоматически — заказы и чат
// доступны и на сайте (пароль можно задать позже владельцу по запросу).
async function ensureUser(chatId, from) {
  const cid = String(chatId);
  let user = await db.get('SELECT * FROM users WHERE telegram_chat_id = ?', [cid]);
  if (user) return user;

  const base = (from && from.username ? from.username : 'tg' + cid).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 20);
  let username = base || 'tg' + cid;
  if (username.length < 3) username = 'tg' + cid;

  // Гарантируем уникальность юзернейма
  for (let i = 0; i < 50; i++) {
    const taken = await db.get('SELECT id FROM users WHERE username = ? COLLATE NOCASE', [username]);
    if (!taken) break;
    username = (base || 'tg').slice(0, 16) + '_' + Math.floor(Math.random() * 9999);
  }

  const displayName = [from && from.first_name, from && from.last_name].filter(Boolean).join(' ') || username;
  const hash = bcrypt.hashSync(crypto.randomBytes(12).toString('hex'), 10);
  const info = await db.run(
    'INSERT INTO users (username, password_hash, display_name, phone, telegram_chat_id) VALUES (?, ?, ?, ?, ?)',
    [username, hash, displayName, '', cid]
  );
  return db.get('SELECT * FROM users WHERE id = ?', [Number(info.lastInsertRowid)]);
}

// ---------------- клавиатуры ----------------
function mainMenu() {
  return tg.inlineKeyboard([
    [{ text: '🛍 Каталог', callback_data: 'cat' }],
    [{ text: '📦 Мои заказы', callback_data: 'my' }],
  ]);
}

function ownerMenu() {
  return tg.inlineKeyboard([
    [{ text: '📦 Последние заказы', callback_data: 'oorders' }],
    [{ text: '🛍 Каталог (как видит клиент)', callback_data: 'cat' }],
  ]);
}

// ---------------- экраны клиента ----------------
async function showCatalog(chatId) {
  const products = await db.all('SELECT * FROM products WHERE is_active = 1 ORDER BY created_at DESC LIMIT 40');
  if (!products.length) {
    return tg.sendMessage(chatId, 'Пока нет доступных моделей. Загляните позже 🙂', mainMenu());
  }
  const rows = products.map((p) => [{ text: `${p.name} — ${money(p.price)}`, callback_data: 'p:' + p.id }]);
  return tg.sendMessage(chatId, '🛍 <b>Каталог моделей</b>\nВыберите модель:', tg.inlineKeyboard(rows));
}

async function showProduct(chatId, productId) {
  const p = await db.get('SELECT * FROM products WHERE id = ? AND is_active = 1', [productId]);
  if (!p) return tg.sendMessage(chatId, 'Модель недоступна.', mainMenu());

  const variants = await db.all('SELECT * FROM variants WHERE product_id = ? ORDER BY id', [p.id]);
  const rows = variants.length
    ? variants.map((v) => [
        {
          text: `${v.name}${v.extra_price ? ' (+' + money(v.extra_price) + ')' : ''} — ${money(p.price + v.extra_price)}`,
          callback_data: `v:${p.id}:${v.id}`,
        },
      ])
    : [[{ text: `Заказать — ${money(p.price)}`, callback_data: `v:${p.id}:0` }]];
  rows.push([{ text: '← Назад к каталогу', callback_data: 'cat' }]);

  const caption =
    `<b>${esc(p.name)}</b>\n\n` +
    (p.description ? esc(p.description) + '\n\n' : '') +
    `Цена: <b>${money(p.price)}</b>\n` +
    (variants.length ? 'Выберите вариант филамента:' : 'Нажмите, чтобы заказать:');

  if (p.image) {
    const img = await db.get('SELECT mime, data FROM images WHERE id = ?', [parseInt(p.image, 10)]);
    if (img) {
      const buf = Buffer.isBuffer(img.data) ? img.data : Buffer.from(img.data);
      const sent = await tg.sendPhoto(chatId, buf, img.mime, caption, tg.inlineKeyboard(rows).reply_markup
        ? { reply_markup: JSON.stringify(tg.inlineKeyboard(rows).reply_markup) }
        : {});
      if (sent.ok) return sent;
    }
  }
  return tg.sendMessage(chatId, caption, tg.inlineKeyboard(rows));
}

async function askQuantity(chatId, productId, variantId) {
  await setState(chatId, 'qty', { product_id: productId, variant_id: variantId });
  return tg.sendMessage(
    chatId,
    'Сколько штук нужно?',
    tg.inlineKeyboard([
      [
        { text: '1', callback_data: 'q:1' },
        { text: '2', callback_data: 'q:2' },
        { text: '3', callback_data: 'q:3' },
      ],
      [{ text: '❌ Отмена', callback_data: 'no' }],
    ])
  );
}

async function askName(chatId, data, user) {
  await setState(chatId, 'name', data);
  const suggested = user && user.display_name ? user.display_name : '';
  return tg.sendMessage(
    chatId,
    'Как к вам обращаться?' + (suggested ? `\n\nМожно отправить «-», чтобы использовать: <b>${esc(suggested)}</b>` : '')
  );
}

async function askPhone(chatId, data) {
  await setState(chatId, 'phone', data);
  return tg.sendMessage(chatId, 'Укажите телефон для связи.\n(или отправьте «-», чтобы пропустить)');
}

async function askAddress(chatId, data) {
  await setState(chatId, 'address', data);
  return tg.sendMessage(chatId, 'Куда доставить или где заберёте заказ?\n(или отправьте «-», чтобы уточнить позже)');
}

async function showConfirm(chatId, data) {
  const p = await db.get('SELECT * FROM products WHERE id = ?', [data.product_id]);
  const v = data.variant_id ? await db.get('SELECT * FROM variants WHERE id = ?', [data.variant_id]) : null;
  if (!p) {
    await clearState(chatId);
    return tg.sendMessage(chatId, 'Модель недоступна.', mainMenu());
  }
  const unit = p.price + (v ? v.extra_price : 0);
  const total = unit * data.quantity;
  data.total = total;
  await setState(chatId, 'confirm', data);

  const text =
    '🧾 <b>Проверьте заказ</b>\n\n' +
    `<b>${esc(p.name)}</b>${v ? ' · ' + esc(v.name) : ''}\n` +
    `Количество: ${data.quantity}\n` +
    `Итого: <b>${money(total)}</b>\n` +
    '💵 Оплата при получении\n\n' +
    `👤 ${esc(data.customer_name)}\n` +
    (data.phone ? `📞 ${esc(data.phone)}\n` : '') +
    (data.address ? `📍 ${esc(data.address)}\n` : '');

  return tg.sendMessage(
    chatId,
    text,
    tg.inlineKeyboard([
      [{ text: '✅ Подтвердить заказ', callback_data: 'ok' }],
      [{ text: '❌ Отмена', callback_data: 'no' }],
    ])
  );
}

async function createOrder(chatId, from) {
  const { data } = await getState(chatId);
  if (!data || !data.product_id) {
    await clearState(chatId);
    return tg.sendMessage(chatId, 'Заказ не найден, начните заново.', mainMenu());
  }
  const user = await ensureUser(chatId, from);
  const p = await db.get('SELECT * FROM products WHERE id = ? AND is_active = 1', [data.product_id]);
  if (!p) {
    await clearState(chatId);
    return tg.sendMessage(chatId, 'Модель уже недоступна.', mainMenu());
  }
  const v = data.variant_id ? await db.get('SELECT * FROM variants WHERE id = ?', [data.variant_id]) : null;
  const unit = p.price + (v ? v.extra_price : 0);
  const qty = Math.max(1, parseInt(data.quantity, 10) || 1);
  const total = unit * qty;
  const token = crypto.randomBytes(24).toString('hex');

  const info = await db.run(
    `INSERT INTO orders
       (token, user_id, product_id, variant_id, product_name, variant_name, unit_price, quantity, total, customer_name, phone, address)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      token,
      user.id,
      p.id,
      v ? v.id : null,
      p.name,
      v ? v.name : '',
      unit,
      qty,
      total,
      data.customer_name || user.display_name || user.username,
      data.phone || '',
      data.address || '',
    ]
  );
  const orderId = Number(info.lastInsertRowid);

  // Сохраним телефон в профиле, если его ещё нет
  if (data.phone && !user.phone) {
    await db.run('UPDATE users SET phone = ? WHERE id = ?', [data.phone, user.id]);
  }

  await clearState(chatId);

  // Уведомление владельцу
  const notify = require('./notify');
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
  notify.notifyNewOrder({ ...order, username: user.username }).catch(() => {});

  return tg.sendMessage(
    chatId,
    `✅ <b>Заказ #${orderId} принят!</b>\n\n` +
      `<b>${esc(p.name)}</b>${v ? ' · ' + esc(v.name) : ''}\n` +
      `${qty} шт · Итого <b>${money(total)}</b>\n` +
      '💵 Оплата при получении\n\n' +
      'Продавец скоро свяжется с вами. Здесь же можно написать ему сообщение.',
    tg.inlineKeyboard([
      [{ text: '💬 Написать продавцу', callback_data: 'msg:' + orderId }],
      [{ text: '📦 Мои заказы', callback_data: 'my' }],
    ])
  );
}

async function showMyOrders(chatId) {
  const user = await db.get('SELECT * FROM users WHERE telegram_chat_id = ?', [String(chatId)]);
  if (!user) return tg.sendMessage(chatId, 'У вас пока нет заказов.', mainMenu());
  const orders = await db.all('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 20', [user.id]);
  if (!orders.length) return tg.sendMessage(chatId, 'У вас пока нет заказов.', mainMenu());

  const rows = orders.map((o) => [
    {
      text: `#${o.id} ${o.product_name} — ${STATUS[o.status] || o.status}`,
      callback_data: 'o:' + o.id,
    },
  ]);
  return tg.sendMessage(chatId, '📦 <b>Ваши заказы</b>', tg.inlineKeyboard(rows));
}

async function showOrder(chatId, orderId, isOwner) {
  const o = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!o) return tg.sendMessage(chatId, 'Заказ не найден.');
  if (!isOwner) {
    const user = await db.get('SELECT * FROM users WHERE telegram_chat_id = ?', [String(chatId)]);
    if (!user || o.user_id !== user.id) return tg.sendMessage(chatId, 'Заказ не найден.');
  }
  const msgs = await db.all('SELECT sender, body FROM messages WHERE order_id = ? ORDER BY id DESC LIMIT 5', [o.id]);
  const chatPart = msgs.length
    ? '\n\n💬 <b>Последние сообщения</b>\n' +
      msgs
        .reverse()
        .map((m) => `${m.sender === 'owner' ? '🧑‍🔧 Продавец' : '👤 Клиент'}: ${esc(m.body.slice(0, 200))}`)
        .join('\n')
    : '';

  const text =
    `📦 <b>Заказ #${o.id}</b>\n\n` +
    `<b>${esc(o.product_name)}</b>${o.variant_name ? ' · ' + esc(o.variant_name) : ''}\n` +
    `${o.quantity} шт · Итого <b>${money(o.total)}</b>\n` +
    `Статус: <b>${STATUS[o.status] || o.status}</b>\n` +
    (isOwner ? `👤 ${esc(o.customer_name)}\n` + (o.phone ? `📞 ${esc(o.phone)}\n` : '') : '') +
    (o.address ? `📍 ${esc(o.address)}\n` : '') +
    chatPart;

  const rows = [[{ text: '💬 Написать', callback_data: 'msg:' + o.id }]];
  if (isOwner) {
    rows.push([
      { text: '✅ Подтвердить', callback_data: `st:${o.id}:confirmed` },
      { text: '🚚 Отправлен', callback_data: `st:${o.id}:shipped` },
    ]);
    rows.push([
      { text: '🏁 Выполнен', callback_data: `st:${o.id}:done` },
      { text: '❌ Отменить', callback_data: `st:${o.id}:cancelled` },
    ]);
  }
  return tg.sendMessage(chatId, text, tg.inlineKeyboard(rows));
}

// ---------------- экраны владельца ----------------
async function showOwnerOrders(chatId) {
  const orders = await db.all('SELECT * FROM orders ORDER BY created_at DESC LIMIT 15');
  if (!orders.length) return tg.sendMessage(chatId, 'Заказов пока нет.', ownerMenu());
  const rows = orders.map((o) => [
    {
      text: `#${o.id} ${o.product_name} · ${money(o.total)} · ${STATUS[o.status] || o.status}`,
      callback_data: 'o:' + o.id,
    },
  ]);
  return tg.sendMessage(chatId, '📦 <b>Последние заказы</b>', tg.inlineKeyboard(rows));
}

async function setOwnerPassword(chatId, newPass) {
  const pass = String(newPass || '').trim();
  if (pass.length < 4) {
    return tg.sendMessage(chatId, '❗ Пароль слишком короткий (минимум 4 символа).\n\nПример: <code>/setpass мойНовыйПароль</code>');
  }
  const hash = bcrypt.hashSync(pass, 10);
  await db.run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ['owner_password_hash', hash]
  );
  // Сбрасываем активные сессии владельца — старые входы больше не действуют
  await db.run('DELETE FROM sessions');
  return tg.sendMessage(
    chatId,
    '🔑 <b>Пароль владельца изменён.</b>\n\nВсе прошлые входы в админку сброшены — войдите заново с новым паролем.'
  );
}

// ---------------- обработка сообщений ----------------
async function handleText(chatId, text, from, isOwner) {
  const trimmed = String(text || '').trim();

  // Команды владельца
  if (isOwner) {
    if (/^\/setpass\b/i.test(trimmed)) {
      return setOwnerPassword(chatId, trimmed.replace(/^\/setpass\s*/i, ''));
    }
    if (/^\/orders\b/i.test(trimmed)) return showOwnerOrders(chatId);
    if (/^\/start\b|^\/menu\b/i.test(trimmed)) {
      return tg.sendMessage(
        chatId,
        '🧊 <b>3D-Store — панель владельца</b>\n\n' +
          'Команды:\n' +
          '<code>/orders</code> — последние заказы\n' +
          '<code>/setpass новый_пароль</code> — сменить пароль админки\n' +
          '<code>/menu</code> — это меню',
        ownerMenu()
      );
    }
  }

  const { state, data } = await getState(chatId);

  // Пошаговое оформление заказа
  if (state === 'qty') {
    const n = parseInt(trimmed, 10);
    if (!n || n < 1 || n > 999) return tg.sendMessage(chatId, 'Введите количество числом, например 2.');
    data.quantity = n;
    const user = await db.get('SELECT * FROM users WHERE telegram_chat_id = ?', [String(chatId)]);
    return askName(chatId, data, user);
  }

  if (state === 'name') {
    let name = trimmed;
    if (name === '-') {
      const user = await db.get('SELECT * FROM users WHERE telegram_chat_id = ?', [String(chatId)]);
      name = (user && user.display_name) || (from && from.first_name) || 'Клиент';
    }
    if (!name) return tg.sendMessage(chatId, 'Пожалуйста, укажите имя.');
    data.customer_name = name.slice(0, 100);
    return askPhone(chatId, data);
  }

  if (state === 'phone') {
    data.phone = trimmed === '-' ? '' : trimmed.slice(0, 50);
    return askAddress(chatId, data);
  }

  if (state === 'address') {
    data.address = trimmed === '-' ? '' : trimmed.slice(0, 300);
    return showConfirm(chatId, data);
  }

  // Сообщение в чат заказа
  if (state === 'chat' && data.order_id) {
    const o = await db.get('SELECT * FROM orders WHERE id = ?', [data.order_id]);
    if (!o) {
      await clearState(chatId);
      return tg.sendMessage(chatId, 'Заказ не найден.', isOwner ? ownerMenu() : mainMenu());
    }
    if (!trimmed) return tg.sendMessage(chatId, 'Введите текст сообщения.');

    const notify = require('./notify');
    if (isOwner) {
      await db.run('INSERT INTO messages (order_id, sender, body) VALUES (?, ?, ?)', [o.id, 'owner', trimmed]);
      notify.notifyCustomerMessage(o, trimmed).catch(() => {});
      await clearState(chatId);
      return tg.sendMessage(chatId, `✅ Отправлено клиенту по заказу #${o.id}.`, ownerMenu());
    }
    await db.run('INSERT INTO messages (order_id, sender, body) VALUES (?, ?, ?)', [o.id, 'customer', trimmed]);
    const acc = o.user_id ? await db.get('SELECT username FROM users WHERE id = ?', [o.user_id]) : null;
    notify.notifyNewMessage({ ...o, username: acc ? acc.username : null }, trimmed).catch(() => {});
    await clearState(chatId);
    return tg.sendMessage(chatId, '✅ Сообщение отправлено продавцу.', mainMenu());
  }

  // Приветствие / всё остальное
  if (isOwner) {
    return tg.sendMessage(chatId, 'Не понял команду. Откройте меню: /menu', ownerMenu());
  }
  await ensureUser(chatId, from);
  return tg.sendMessage(
    chatId,
    '🧊 <b>3D-Store</b>\nМодели, напечатанные на 3D-принтере.\n\n' +
      '💵 Оплата при получении\n\nВыберите действие:',
    mainMenu()
  );
}

async function handleCallback(cb, isOwner) {
  const chatId = cb.message.chat.id;
  const dataStr = cb.data || '';
  await tg.answerCallback(cb.id);

  if (dataStr === 'cat') return showCatalog(chatId);
  if (dataStr === 'my') return showMyOrders(chatId);
  if (dataStr === 'oorders' && isOwner) return showOwnerOrders(chatId);
  if (dataStr === 'no') {
    await clearState(chatId);
    return tg.sendMessage(chatId, 'Отменено.', isOwner ? ownerMenu() : mainMenu());
  }

  if (dataStr.startsWith('p:')) return showProduct(chatId, parseInt(dataStr.slice(2), 10));

  if (dataStr.startsWith('v:')) {
    const [, pid, vid] = dataStr.split(':');
    return askQuantity(chatId, parseInt(pid, 10), parseInt(vid, 10) || 0);
  }

  if (dataStr.startsWith('q:')) {
    const n = parseInt(dataStr.slice(2), 10) || 1;
    const { data } = await getState(chatId);
    if (!data.product_id) return tg.sendMessage(chatId, 'Начните заказ заново.', mainMenu());
    data.quantity = n;
    const user = await db.get('SELECT * FROM users WHERE telegram_chat_id = ?', [String(chatId)]);
    return askName(chatId, data, user);
  }

  if (dataStr === 'ok') return createOrder(chatId, cb.from);

  if (dataStr.startsWith('o:')) return showOrder(chatId, parseInt(dataStr.slice(2), 10), isOwner);

  if (dataStr.startsWith('msg:')) {
    const orderId = parseInt(dataStr.slice(4), 10);
    await setState(chatId, 'chat', { order_id: orderId });
    return tg.sendMessage(chatId, `✍️ Напишите сообщение по заказу #${orderId} — оно уйдёт ${isOwner ? 'клиенту' : 'продавцу'}.`);
  }

  if (dataStr.startsWith('st:') && isOwner) {
    const [, oid, status] = dataStr.split(':');
    const allowed = ['new', 'confirmed', 'shipped', 'done', 'cancelled'];
    if (!allowed.includes(status)) return;
    const o = await db.get('SELECT * FROM orders WHERE id = ?', [oid]);
    if (!o) return tg.sendMessage(chatId, 'Заказ не найден.');
    await db.run('UPDATE orders SET status = ? WHERE id = ?', [status, o.id]);
    const notify = require('./notify');
    notify.notifyCustomerStatus({ ...o, status }, status).catch(() => {});
    return tg.sendMessage(chatId, `✅ Заказ #${o.id}: статус изменён на «${STATUS[status]}».`);
  }
}

async function handleUpdate(update) {
  const { ownerChatId } = await tg.config();
  try {
    if (update.callback_query) {
      const cb = update.callback_query;
      const isOwner = String(cb.message.chat.id) === String(ownerChatId);
      return await handleCallback(cb, isOwner);
    }
    const msg = update.message;
    if (!msg || !msg.chat) return;
    const chatId = msg.chat.id;
    const isOwner = String(chatId) === String(ownerChatId);
    if (msg.text) return await handleText(chatId, msg.text, msg.from, isOwner);
    // Прочие типы сообщений (фото, стикеры) — мягкая подсказка
    return await tg.sendMessage(chatId, 'Пожалуйста, отправьте текст или воспользуйтесь меню.', isOwner ? ownerMenu() : mainMenu());
  } catch (e) {
    console.error('[bot] ошибка обработки обновления:', e.message);
  }
}

// ---------------- цикл получения обновлений ----------------
async function pollLoop() {
  let backoff = 1000;
  while (!stopped) {
    const { token } = await tg.config();
    if (!token) {
      // Токен ещё не задан — ждём и пробуем снова
      await sleep(15000);
      continue;
    }
    const res = await tg.callWithToken(
      token,
      'getUpdates',
      { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] },
      { timeoutMs: 40000 }
    );

    if (!res.ok) {
      if (res.code === 409) {
        console.warn('[bot] конфликт getUpdates: бот уже запущен в другом месте. Жду…');
        await sleep(30000);
        continue;
      }
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60000);
      continue;
    }
    backoff = 1000;

    for (const update of res.result || []) {
      offset = update.update_id + 1;
      await handleUpdate(update);
    }
  }
  running = false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function setupCommands() {
  await tg.call('setMyCommands', {
    commands: [
      { command: 'start', description: 'Каталог и заказы' },
      { command: 'menu', description: 'Главное меню' },
    ],
  });
}

function startBot() {
  if (running) return;
  running = true;
  stopped = false;
  setupCommands().catch(() => {});
  pollLoop().catch((e) => {
    console.error('[bot] цикл опроса остановлен:', e.message);
    running = false;
  });
  console.log('[3D-Store] Telegram-бот запущен.');
}

function stopBot() {
  stopped = true;
}

module.exports = { startBot, stopBot, handleUpdate, STATUS };
