'use strict';

const contentEl = document.getElementById('content');
let pollTimer = null;
let chatToken = null;

function money(n) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' ₽';
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
function fmtDate(s) {
  const d = new Date((s || '').replace(' ', 'T') + 'Z');
  if (isNaN(d)) return s;
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// Образец цвета филамента: {"c":["#hex",...],"m":bool}
function swBg(spec) {
  try {
    const o = typeof spec === 'string' ? JSON.parse(spec) : spec;
    const colors = (o && Array.isArray(o.c) ? o.c : []).filter((x) => /^#[0-9a-fA-F]{6}$/.test(x));
    if (!colors.length) return '';
    const base =
      colors.length > 1
        ? `linear-gradient(135deg, ${colors.join(', ')})`
        : `linear-gradient(135deg, ${colors[0]}, ${colors[0]})`;
    return o.m
      ? `linear-gradient(115deg, rgba(255,255,255,0) 25%, rgba(255,255,255,.8) 50%, rgba(255,255,255,0) 72%), ${base}`
      : base;
  } catch {
    return '';
  }
}
function swHtml(spec, cls) {
  const bg = swBg(spec);
  return bg ? `<i class="sw${cls ? ' ' + cls : ''}" style="background:${bg}"></i>` : '';
}

const STATUS = {
  new: 'Новый', confirmed: 'Подтверждён', shipped: 'Отправлен', done: 'Выполнен', cancelled: 'Отменён',
};

function getParam(name) {
  return new URLSearchParams(location.search).get(name);
}

async function init() {
  await window.Auth.refresh();
  const token = getParam('token');
  if (token) {
    return openOrderChat(token);
  }
  return listMyOrders();
}

// Список заказов текущего аккаунта
async function listMyOrders() {
  const st = window.Auth.getState();
  if (!st.user) {
    contentEl.innerHTML =
      '<div class="notice">Войдите в аккаунт, чтобы увидеть свои заказы и переписку с продавцом.</div>' +
      '<button class="btn primary" id="needLogin">Войти / зарегистрироваться</button>';
    document.getElementById('needLogin').addEventListener('click', () => window.Auth.require(() => init()));
    return;
  }
  contentEl.innerHTML = '<div class="empty">Загрузка заказов…</div>';
  const res = await fetch('/api/my/orders');
  if (!res.ok) {
    contentEl.innerHTML = '<div class="empty">Не удалось загрузить заказы.</div>';
    return;
  }
  const orders = await res.json();
  if (!orders.length) {
    contentEl.innerHTML =
      '<div class="empty">У вас пока нет заказов.<br/><a class="btn primary" href="/" style="margin-top:14px;">Перейти в каталог</a></div>';
    return;
  }
  contentEl.innerHTML =
    '<div class="orders-list">' +
    orders
      .map(
        (o) => `
      <div class="order-item">
        <div class="info">
          <h4>${esc(o.product_name)} ${o.variant_name ? '· ' + swHtml(o.variant_color) + esc(o.variant_name) : ''}</h4>
          <div class="sub">${o.quantity} шт · ${money(o.total)} · оплата при получении · ${fmtDate(o.created_at)}</div>
          ${o.gift_name ? `<div class="sub gift-line">🎁 Подарок: ${esc(o.gift_name)}</div>` : ''}
        </div>
        <div class="right">
          <span class="status-pill status-${o.status}">${STATUS[o.status] || o.status}</span>
          <a class="btn small primary" href="/order?token=${encodeURIComponent(o.token)}">Открыть чат</a>
        </div>
      </div>`
      )
      .join('') +
    '</div>';
}

// Просмотр конкретного заказа + чат
async function openOrderChat(token) {
  chatToken = token;
  const res = await fetch('/api/orders/by-token/' + encodeURIComponent(token));
  if (!res.ok) {
    contentEl.innerHTML = '<div class="empty">Заказ не найден. Возможно, ссылка неверна.</div>';
    return;
  }
  const o = await res.json();
  contentEl.innerHTML = `
    <a class="btn ghost small" href="/order" style="margin-bottom:14px;">← Все мои заказы</a>
    <div class="order-item" style="margin-bottom:16px;">
      <div class="info">
        <h4>${esc(o.product_name)} ${o.variant_name ? '· ' + swHtml(o.variant_color) + esc(o.variant_name) : ''}</h4>
        <div class="sub">${o.quantity} шт · Итого ${money(o.total)}${o.discount_percent ? ` · скидка ${o.discount_percent}%` : ''} · 💵 оплата при получении</div>
        ${o.gift_name ? `<div class="sub gift-line">🎁 В подарок: ${esc(o.gift_name)}</div>` : ''}
        ${o.address ? `<div class="sub">Выдача: ${esc(o.address)}</div>` : ''}
      </div>
      <div class="right"><span class="status-pill status-${o.status}" id="statusPill">${STATUS[o.status] || o.status}</span></div>
    </div>

    <div class="card" style="overflow:visible;">
      <div class="chat" id="chatBox">
        <div class="chat-messages" id="chatMessages"><div class="empty">Загрузка чата…</div></div>
        <div class="chat-input">
          <input type="text" id="chatInput" placeholder="Напишите продавцу…" autocomplete="off" />
          <button class="btn primary" id="chatSend">Отправить</button>
        </div>
      </div>
    </div>
    <div class="hint" style="margin-top:10px;">💡 Ссылка на этот чат уникальна — по ней вы всегда сможете вернуться к заказу.</div>
  `;

  document.getElementById('chatSend').addEventListener('click', sendMessage);
  document.getElementById('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage();
  });

  await loadMessages();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(loadMessages, 4000);
}

let lastCount = -1;
async function loadMessages() {
  if (!chatToken) return;
  try {
    const res = await fetch('/api/chat/by-token/' + encodeURIComponent(chatToken));
    if (!res.ok) return;
    const data = await res.json();
    renderMessages(data.messages);
    const pill = document.getElementById('statusPill');
    if (pill && data.status) {
      pill.className = 'status-pill status-' + data.status;
      pill.textContent = STATUS[data.status] || data.status;
    }
  } catch {}
}

function renderMessages(messages) {
  const box = document.getElementById('chatMessages');
  if (!box) return;
  if (!messages.length) {
    box.innerHTML = '<div class="empty">Сообщений пока нет. Напишите первым 👋</div>';
    lastCount = 0;
    return;
  }
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.innerHTML = messages
    .map(
      (m) => `
      <div class="bubble ${m.sender === 'owner' ? 'owner' : 'customer'}">
        ${esc(m.body)}
        <span class="meta">${m.sender === 'owner' ? 'Продавец' : 'Вы'} · ${fmtDate(m.created_at)}</span>
      </div>`
    )
    .join('');
  if (atBottom || messages.length !== lastCount) box.scrollTop = box.scrollHeight;
  lastCount = messages.length;
}

async function sendMessage() {
  const input = document.getElementById('chatInput');
  const body = input.value.trim();
  if (!body) return;
  input.value = '';
  try {
    const res = await fetch('/api/chat/by-token/' + encodeURIComponent(chatToken), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    const data = await res.json();
    if (res.ok) renderMessages(data.messages);
  } catch {}
}

window.onAuthLogout = function () {
  location.href = '/order';
};

init();
