'use strict';

// Низкоуровневая работа с Telegram Bot API.
// Настройки берутся из таблицы settings (задаются в админке),
// с запасным вариантом из переменных окружения.

const db = require('./db');

const API = 'https://api.telegram.org';

async function getSetting(key, envName) {
  const row = await db.get('SELECT value FROM settings WHERE key = ?', [key]);
  if (row && row.value) return row.value;
  return envName && process.env[envName] ? process.env[envName] : '';
}

async function config() {
  const [token, ownerChatId] = await Promise.all([
    getSetting('telegram_bot_token', 'TELEGRAM_BOT_TOKEN'),
    getSetting('telegram_chat_id', 'TELEGRAM_CHAT_ID'),
  ]);
  return { token, ownerChatId: String(ownerChatId || '') };
}

// Вызов метода Bot API. Возвращает {ok, result?, error?}.
async function call(method, params = {}, { timeoutMs = 20000 } = {}) {
  const { token } = await config();
  if (!token) return { ok: false, error: 'Telegram не настроен' };
  return callWithToken(token, method, params, { timeoutMs });
}

async function callWithToken(token, method, params = {}, { timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      return { ok: false, error: (data && data.description) || `HTTP ${res.status}`, code: res.status };
    }
    return { ok: true, result: data.result };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'таймаут' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function money(n) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' ₽';
}

async function sendMessage(chatId, text, extra = {}) {
  return call('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}

// Отправка фото байтами (фото лежат в базе, публичный URL не нужен).
async function sendPhoto(chatId, buffer, mime, caption, extra = {}) {
  const { token } = await config();
  if (!token) return { ok: false, error: 'Telegram не настроен' };
  try {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) {
      form.append('caption', caption);
      form.append('parse_mode', 'HTML');
    }
    for (const [k, v] of Object.entries(extra)) {
      form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    const ext = (mime || '').includes('png') ? 'png' : 'jpg';
    form.append('photo', new Blob([buffer], { type: mime || 'image/jpeg' }), `photo.${ext}`);

    const res = await fetch(`${API}/bot${token}/sendPhoto`, { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) return { ok: false, error: (data && data.description) || `HTTP ${res.status}` };
    return { ok: true, result: data.result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function answerCallback(callbackId, text = '', showAlert = false) {
  return call('answerCallbackQuery', { callback_query_id: callbackId, text, show_alert: showAlert });
}

async function editMessageText(chatId, messageId, text, extra = {}) {
  return call('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}

async function deleteMessage(chatId, messageId) {
  return call('deleteMessage', { chat_id: chatId, message_id: messageId });
}

// Клавиатуры
function inlineKeyboard(rows) {
  return { reply_markup: { inline_keyboard: rows } };
}
function replyKeyboard(rows) {
  return { reply_markup: { keyboard: rows, resize_keyboard: true } };
}

module.exports = {
  config,
  call,
  callWithToken,
  sendMessage,
  sendPhoto,
  answerCallback,
  editMessageText,
  deleteMessage,
  inlineKeyboard,
  replyKeyboard,
  esc,
  money,
};
