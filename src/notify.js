'use strict';

// Уведомления: владельцу — о заказах и сообщениях клиентов,
// клиентам — об ответах продавца и смене статуса заказа.

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

async function telegramConfig() {
  const { token, ownerChatId } = await tg.config();
  return { token, chatId: ownerChatId };
}

async function isConfigured() {
  const { token, chatId } = await telegramConfig();
  return Boolean(token && chatId);
}

// Отправка владельцу. Возвращает {ok, error?}.
async function sendTelegram(text) {
  const { token, chatId } = await telegramConfig();
  if (!token || !chatId) return { ok: false, error: 'Telegram не настроен' };
  const res = await tg.sendMessage(chatId, text);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

// ---------- владельцу ----------
async function notifyNewOrder(order) {
  if (!(await isConfigured())) return;
  const lines = [
    '📦 <b>Новый заказ #' + order.id + '</b>',
    '',
    '<b>' + esc(order.product_name) + '</b>' + (order.variant_name ? ' · ' + esc(order.variant_name) : ''),
    'Кол-во: ' + order.quantity + ' · Итого: <b>' + money(order.total) + '</b>',
    '💵 Оплата при получении',
    '',
    '👤 ' + esc(order.customer_name) + (order.username ? ' (@' + esc(order.username) + ')' : ''),
  ];
  if (order.phone) lines.push('📞 ' + esc(order.phone));
  if (order.address) lines.push('📍 ' + esc(order.address));

  const { chatId } = await telegramConfig();
  await tg.sendMessage(
    chatId,
    lines.join('\n'),
    tg.inlineKeyboard([[{ text: '📋 Открыть заказ', callback_data: 'o:' + order.id }]])
  );
}

async function notifyNewMessage(order, body) {
  if (!(await isConfigured())) return;
  const text =
    '💬 <b>Сообщение по заказу #' +
    order.id +
    '</b>\n' +
    esc(order.customer_name) +
    (order.username ? ' (@' + esc(order.username) + ')' : '') +
    ':\n\n«' +
    esc(String(body).slice(0, 500)) +
    '»';
  const { chatId } = await telegramConfig();
  await tg.sendMessage(
    chatId,
    text,
    tg.inlineKeyboard([[{ text: '✍️ Ответить', callback_data: 'msg:' + order.id }]])
  );
}

// ---------- клиенту ----------
async function customerChatId(order) {
  if (!order || !order.user_id) return '';
  const u = await db.get('SELECT telegram_chat_id FROM users WHERE id = ?', [order.user_id]);
  return u && u.telegram_chat_id ? String(u.telegram_chat_id) : '';
}

// Ответ продавца в чате заказа
async function notifyCustomerMessage(order, body) {
  const chatId = await customerChatId(order);
  if (!chatId) return;
  await tg.sendMessage(
    chatId,
    `💬 <b>Ответ продавца по заказу #${order.id}</b>\n\n«${esc(String(body).slice(0, 800))}»`,
    tg.inlineKeyboard([[{ text: '✍️ Ответить', callback_data: 'msg:' + order.id }]])
  );
}

// Смена статуса заказа
async function notifyCustomerStatus(order, status) {
  const chatId = await customerChatId(order);
  if (!chatId) return;
  const emoji = { confirmed: '✅', shipped: '🚚', done: '🏁', cancelled: '❌', new: '🆕' }[status] || 'ℹ️';
  await tg.sendMessage(
    chatId,
    `${emoji} <b>Заказ #${order.id}</b>\n` +
      `<b>${esc(order.product_name)}</b>\n\n` +
      `Новый статус: <b>${STATUS[status] || status}</b>`,
    tg.inlineKeyboard([[{ text: '📦 Открыть заказ', callback_data: 'o:' + order.id }]])
  );
}

module.exports = {
  sendTelegram,
  notifyNewOrder,
  notifyNewMessage,
  notifyCustomerMessage,
  notifyCustomerStatus,
  isConfigured,
  telegramConfig,
};
