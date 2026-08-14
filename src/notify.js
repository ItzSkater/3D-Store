'use strict';

// Уведомления владельцу через Telegram-бота.
// Настройки берутся из таблицы settings (их можно задать в админке),
// с запасным вариантом из переменных окружения.

const db = require('./db');

function getSetting(key, envName) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (row && row.value) return row.value;
  return envName && process.env[envName] ? process.env[envName] : '';
}

function telegramConfig() {
  return {
    token: getSetting('telegram_bot_token', 'TELEGRAM_BOT_TOKEN'),
    chatId: getSetting('telegram_chat_id', 'TELEGRAM_CHAT_ID'),
  };
}

function isConfigured() {
  const { token, chatId } = telegramConfig();
  return Boolean(token && chatId);
}

// Отправка сообщения в Telegram. Возвращает {ok, error?}.
async function sendTelegram(text) {
  const { token, chatId } = telegramConfig();
  if (!token || !chatId) return { ok: false, error: 'Telegram не настроен' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      return { ok: false, error: (data && data.description) || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function money(n) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' ₽';
}

// Уведомление о новом заказе. Не блокирует ответ клиенту (fire-and-forget).
function notifyNewOrder(order) {
  if (!isConfigured()) return;
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
  sendTelegram(lines.join('\n')).catch(() => {});
}

// Уведомление о новом сообщении от клиента.
function notifyNewMessage(order, body) {
  if (!isConfigured()) return;
  const text =
    '💬 <b>Сообщение по заказу #' +
    order.id +
    '</b>\n' +
    esc(order.customer_name) +
    (order.username ? ' (@' + esc(order.username) + ')' : '') +
    ':\n\n«' +
    esc(body.slice(0, 500)) +
    '»';
  sendTelegram(text).catch(() => {});
}

module.exports = { sendTelegram, notifyNewOrder, notifyNewMessage, isConfigured, telegramConfig };
