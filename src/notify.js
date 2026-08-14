'use strict';

// Уведомления владельцу через Telegram-бота.
// Настройки берутся из таблицы settings (задаются в админке),
// с запасным вариантом из переменных окружения.

const db = require('./db');

async function getSetting(key, envName) {
  const row = await db.get('SELECT value FROM settings WHERE key = ?', [key]);
  if (row && row.value) return row.value;
  return envName && process.env[envName] ? process.env[envName] : '';
}

async function telegramConfig() {
  const [token, chatId] = await Promise.all([
    getSetting('telegram_bot_token', 'TELEGRAM_BOT_TOKEN'),
    getSetting('telegram_chat_id', 'TELEGRAM_CHAT_ID'),
  ]);
  return { token, chatId };
}

async function isConfigured() {
  const { token, chatId } = await telegramConfig();
  return Boolean(token && chatId);
}

// Отправка сообщения в Telegram. Возвращает {ok, error?}.
async function sendTelegram(text) {
  const { token, chatId } = await telegramConfig();
  if (!token || !chatId) return { ok: false, error: 'Telegram не настроен' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
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

// Уведомление о новом заказе (fire-and-forget).
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
  sendTelegram(lines.join('\n')).catch(() => {});
}

// Уведомление о новом сообщении от клиента.
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
  sendTelegram(text).catch(() => {});
}

module.exports = { sendTelegram, notifyNewOrder, notifyNewMessage, isConfigured, telegramConfig };
