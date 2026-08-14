'use strict';

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
const STATUS = { new: 'Новый', confirmed: 'Подтверждён', shipped: 'Отправлен', done: 'Выполнен', cancelled: 'Отменён' };

const $ = (id) => document.getElementById(id);
let chatOrderId = null;
let chatPoll = null;

// ---------- Загрузка / вход ----------
async function boot() {
  const res = await fetch('/api/me');
  const data = await res.json();
  if (data.owner) showPanel();
  else showLogin();
}

function showLogin() {
  $('loginScreen').style.display = '';
  $('ownerPanel').style.display = 'none';
  $('ownerNav').style.display = 'none';
}
function showPanel() {
  $('loginScreen').style.display = 'none';
  $('ownerPanel').style.display = '';
  $('ownerNav').style.display = 'flex';
  loadProducts();
  loadOrders();
}

$('ownerLoginBtn').addEventListener('click', async () => {
  const err = $('loginError');
  err.textContent = '';
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: $('ownerPassword').value }),
  });
  const data = await res.json();
  if (!res.ok) { err.textContent = data.error || 'Ошибка'; return; }
  showPanel();
});
$('ownerPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('ownerLoginBtn').click(); });

$('ownerLogout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  showLogin();
});

// ---------- Вкладки ----------
document.querySelectorAll('[data-tab]').forEach((t) =>
  t.addEventListener('click', () => {
    document.querySelectorAll('[data-tab]').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $('tab-products').style.display = t.dataset.tab === 'products' ? '' : 'none';
    $('tab-orders').style.display = t.dataset.tab === 'orders' ? '' : 'none';
  })
);

// ---------- Модели ----------
async function loadProducts() {
  const res = await fetch('/api/products');
  const products = await res.json();
  const box = $('productsAdmin');
  if (!products.length) {
    box.innerHTML = '<div class="empty">Моделей пока нет. Нажмите «Добавить модель».</div>';
    return;
  }
  box.innerHTML = products.map(renderAdminCard).join('');
  box.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', () => openProduct(products.find((p) => p.id == b.dataset.edit)))
  );
}

function renderAdminCard(p) {
  const img = p.image
    ? `<img src="/img/${esc(p.image)}" alt="" />`
    : '<div class="placeholder">🧊</div>';
  const chips = (p.variants || []).map((v) => `<span class="chip">${esc(v.name)}${v.extra_price ? ' +' + money(v.extra_price) : ''}</span>`).join('');
  return `
    <div class="card">
      <div class="thumb">${img}</div>
      <div class="body">
        <h3>${esc(p.name)} ${p.is_active ? '' : '<span class="inactive-tag">скрыта</span>'}</h3>
        <p class="desc">${esc(p.description) || '—'}</p>
        ${chips ? `<div class="chips">${chips}</div>` : ''}
        <div class="price">${money(p.price)}</div>
        <button class="btn small" data-edit="${p.id}">Редактировать</button>
      </div>
    </div>`;
}

// ---------- Модалка модели ----------
const productModal = $('productModal');
function addVariantRow(name = '', extra = '') {
  const row = document.createElement('div');
  row.className = 'variant-row';
  row.innerHTML = `
    <input type="text" placeholder="PLA Красный" value="${esc(name)}" />
    <input type="number" placeholder="доплата ₽" min="0" step="1" value="${extra === '' ? '' : esc(extra)}" />
    <button class="btn danger small" type="button">✕</button>`;
  row.querySelector('button').addEventListener('click', () => row.remove());
  $('variantsBox').appendChild(row);
}

function collectVariants() {
  return Array.from($('variantsBox').querySelectorAll('.variant-row'))
    .map((r) => {
      const inputs = r.querySelectorAll('input');
      return { name: inputs[0].value.trim(), extra_price: Number(inputs[1].value) || 0 };
    })
    .filter((v) => v.name);
}

function openProduct(p) {
  $('productError').textContent = '';
  $('variantsBox').innerHTML = '';
  $('pImage').value = '';
  if (p) {
    $('productModalTitle').textContent = 'Редактирование модели';
    $('pId').value = p.id;
    $('pName').value = p.name;
    $('pDesc').value = p.description || '';
    $('pPrice').value = p.price;
    $('pActive').value = String(p.is_active);
    $('currentImage').innerHTML = p.image ? `Текущее фото: <a href="/img/${esc(p.image)}" target="_blank">открыть</a>. Загрузите новое, чтобы заменить.` : 'Фото не загружено.';
    (p.variants || []).forEach((v) => addVariantRow(v.name, v.extra_price));
    $('deleteProductBtn').style.display = '';
  } else {
    $('productModalTitle').textContent = 'Новая модель';
    $('pId').value = '';
    $('pName').value = '';
    $('pDesc').value = '';
    $('pPrice').value = '';
    $('pActive').value = '1';
    $('currentImage').textContent = '';
    $('deleteProductBtn').style.display = 'none';
  }
  productModal.classList.add('open');
}

$('addProductBtn').addEventListener('click', () => openProduct(null));
$('addVariantBtn').addEventListener('click', () => addVariantRow());
productModal.querySelectorAll('[data-pclose]').forEach((el) => el.addEventListener('click', () => productModal.classList.remove('open')));
productModal.addEventListener('click', (e) => { if (e.target === productModal) productModal.classList.remove('open'); });

$('saveProductBtn').addEventListener('click', async () => {
  const err = $('productError');
  err.textContent = '';
  const name = $('pName').value.trim();
  if (!name) { err.textContent = 'Укажите название.'; return; }

  const fd = new FormData();
  fd.append('name', name);
  fd.append('description', $('pDesc').value.trim());
  fd.append('price', $('pPrice').value || '0');
  fd.append('is_active', $('pActive').value);
  fd.append('variants', JSON.stringify(collectVariants()));
  if ($('pImage').files[0]) fd.append('image', $('pImage').files[0]);

  const id = $('pId').value;
  const url = id ? '/api/products/' + id : '/api/products';
  const method = id ? 'PUT' : 'POST';
  const res = await fetch(url, { method, body: fd });
  const data = await res.json();
  if (!res.ok) { err.textContent = data.error || 'Ошибка'; return; }
  productModal.classList.remove('open');
  loadProducts();
});

$('deleteProductBtn').addEventListener('click', async () => {
  const id = $('pId').value;
  if (!id) return;
  if (!confirm('Удалить эту модель? Действие необратимо.')) return;
  const res = await fetch('/api/products/' + id, { method: 'DELETE' });
  if (res.ok) { productModal.classList.remove('open'); loadProducts(); }
});

// ---------- Заказы ----------
async function loadOrders() {
  const res = await fetch('/api/orders');
  if (!res.ok) return;
  const orders = await res.json();
  const box = $('ordersAdmin');
  const newCount = orders.filter((o) => o.status === 'new').length;
  $('orderBadge').innerHTML = newCount ? `<span class="chip" style="background:var(--accent);color:#1a1205;">${newCount}</span>` : '';
  if (!orders.length) {
    box.innerHTML = '<div class="empty">Заказов пока нет.</div>';
    return;
  }
  box.innerHTML = orders.map(renderOrderRow).join('');
  box.querySelectorAll('[data-order]').forEach((b) =>
    b.addEventListener('click', () => openOrder(orders.find((o) => o.id == b.dataset.order)))
  );
}

function renderOrderRow(o) {
  return `
    <div class="order-item">
      <div class="info">
        <h4>#${o.id} · ${esc(o.product_name)} ${o.variant_name ? '· ' + esc(o.variant_name) : ''}</h4>
        <div class="sub">${esc(o.customer_name)}${o.username ? ' (@' + esc(o.username) + ')' : ''}${o.phone ? ' · ' + esc(o.phone) : ''} · ${o.quantity} шт · ${money(o.total)}</div>
        <div class="sub">${o.address ? 'Выдача: ' + esc(o.address) + ' · ' : ''}${fmtDate(o.created_at)}</div>
      </div>
      <div class="right">
        <span class="status-pill status-${o.status}">${STATUS[o.status] || o.status}</span>
        <button class="btn small primary" data-order="${o.id}">Открыть · чат</button>
      </div>
    </div>`;
}

// ---------- Модалка заказа + чат владельца ----------
const orderModal = $('orderModal');
function openOrder(o) {
  chatOrderId = o.id;
  $('orderModalTitle').textContent = `Заказ #${o.id}`;
  $('orderDetails').innerHTML = `
    <div class="notice">
      <b>${esc(o.product_name)}</b> ${o.variant_name ? '· ' + esc(o.variant_name) : ''}<br/>
      Клиент: ${esc(o.customer_name)}${o.username ? ' (@' + esc(o.username) + ')' : ''}<br/>
      ${o.phone ? 'Телефон: ' + esc(o.phone) + '<br/>' : ''}
      ${o.address ? 'Выдача: ' + esc(o.address) + '<br/>' : ''}
      Количество: ${o.quantity} · Итого: <b>${money(o.total)}</b> · 💵 оплата при получении
    </div>`;
  $('orderStatus').value = o.status;
  orderModal.classList.add('open');
  loadOwnerChat();
  if (chatPoll) clearInterval(chatPoll);
  chatPoll = setInterval(loadOwnerChat, 4000);
}

function closeOrderModal() {
  orderModal.classList.remove('open');
  if (chatPoll) clearInterval(chatPoll);
  chatPoll = null;
  chatOrderId = null;
  loadOrders();
}
orderModal.querySelectorAll('[data-oclose]').forEach((el) => el.addEventListener('click', closeOrderModal));
orderModal.addEventListener('click', (e) => { if (e.target === orderModal) closeOrderModal(); });

$('saveStatusBtn').addEventListener('click', async () => {
  if (!chatOrderId) return;
  const res = await fetch('/api/orders/' + chatOrderId + '/status', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: $('orderStatus').value }),
  });
  if (res.ok) $('saveStatusBtn').textContent = 'Сохранено ✓';
  setTimeout(() => ($('saveStatusBtn').textContent = 'Сохранить статус'), 1500);
});

let ownerLastCount = -1;
async function loadOwnerChat() {
  if (!chatOrderId) return;
  const res = await fetch('/api/chat/order/' + chatOrderId);
  if (!res.ok) return;
  const data = await res.json();
  renderOwnerChat(data.messages);
}

function renderOwnerChat(messages) {
  const box = $('ownerChatMessages');
  if (!box) return;
  if (!messages.length) {
    box.innerHTML = '<div class="empty">Сообщений пока нет.</div>';
    ownerLastCount = 0;
    return;
  }
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.innerHTML = messages
    .map(
      (m) => `
      <div class="bubble ${m.sender === 'owner' ? 'owner' : 'customer'}">
        ${esc(m.body)}
        <span class="meta">${m.sender === 'owner' ? 'Вы' : 'Клиент'} · ${fmtDate(m.created_at)}</span>
      </div>`
    )
    .join('');
  if (atBottom || messages.length !== ownerLastCount) box.scrollTop = box.scrollHeight;
  ownerLastCount = messages.length;
}

async function ownerSend() {
  const input = $('ownerChatInput');
  const body = input.value.trim();
  if (!body || !chatOrderId) return;
  input.value = '';
  const res = await fetch('/api/chat/order/' + chatOrderId, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  const data = await res.json();
  if (res.ok) renderOwnerChat(data.messages);
}
$('ownerChatSend').addEventListener('click', ownerSend);
$('ownerChatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') ownerSend(); });

// ---------- Смена пароля ----------
const passModal = $('passModal');
$('changePassBtn').addEventListener('click', () => {
  $('curPass').value = ''; $('newPass').value = '';
  $('passError').textContent = ''; $('passOk').textContent = '';
  passModal.classList.add('open');
});
passModal.querySelectorAll('[data-passclose]').forEach((el) => el.addEventListener('click', () => passModal.classList.remove('open')));
passModal.addEventListener('click', (e) => { if (e.target === passModal) passModal.classList.remove('open'); });
$('savePassBtn').addEventListener('click', async () => {
  $('passError').textContent = ''; $('passOk').textContent = '';
  const res = await fetch('/api/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current: $('curPass').value, next: $('newPass').value }),
  });
  const data = await res.json();
  if (!res.ok) { $('passError').textContent = data.error || 'Ошибка'; return; }
  $('passOk').textContent = 'Пароль изменён ✓';
  setTimeout(() => passModal.classList.remove('open'), 1200);
});

// ---------- Настройки уведомлений (Telegram) ----------
const notifyModal = $('notifyModal');
async function openNotify() {
  $('notifyError').textContent = '';
  $('notifyOk').textContent = '';
  $('tgToken').value = '';
  $('tgChatId').value = '';
  $('tokenHint').textContent = '';
  const res = await fetch('/api/settings');
  if (res.ok) {
    const s = await res.json();
    $('tgChatId').value = s.telegram_chat_id || '';
    $('tokenHint').textContent = s.telegram_token_set
      ? 'Токен уже сохранён. Оставьте поле пустым, чтобы не менять его.'
      : 'Токен ещё не задан.';
    $('notifyStatus').innerHTML = s.telegram_configured
      ? '<span style="color:var(--ok);">● Уведомления включены</span>'
      : '<span style="color:var(--warn);">● Уведомления пока не настроены</span>';
  }
  notifyModal.classList.add('open');
}
$('notifyBtn').addEventListener('click', openNotify);
notifyModal.querySelectorAll('[data-notifyclose]').forEach((el) => el.addEventListener('click', () => notifyModal.classList.remove('open')));
notifyModal.addEventListener('click', (e) => { if (e.target === notifyModal) notifyModal.classList.remove('open'); });

$('tgSaveBtn').addEventListener('click', async () => {
  $('notifyError').textContent = ''; $('notifyOk').textContent = '';
  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telegram_bot_token: $('tgToken').value, telegram_chat_id: $('tgChatId').value }),
  });
  const data = await res.json();
  if (!res.ok) { $('notifyError').textContent = data.error || 'Ошибка'; return; }
  $('notifyOk').textContent = data.telegram_configured ? 'Сохранено ✓ Уведомления включены.' : 'Сохранено. Укажите и токен, и Chat ID.';
  $('tgToken').value = '';
  openNotifyRefresh();
});

async function openNotifyRefresh() {
  const res = await fetch('/api/settings');
  if (!res.ok) return;
  const s = await res.json();
  $('notifyStatus').innerHTML = s.telegram_configured
    ? '<span style="color:var(--ok);">● Уведомления включены</span>'
    : '<span style="color:var(--warn);">● Уведомления пока не настроены</span>';
  $('tokenHint').textContent = s.telegram_token_set ? 'Токен уже сохранён. Оставьте поле пустым, чтобы не менять его.' : 'Токен ещё не задан.';
}

$('tgTestBtn').addEventListener('click', async () => {
  $('notifyError').textContent = ''; $('notifyOk').textContent = '';
  // Сначала сохраним введённые значения, затем отправим тест
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telegram_bot_token: $('tgToken').value, telegram_chat_id: $('tgChatId').value }),
  });
  const res = await fetch('/api/settings/test-telegram', { method: 'POST' });
  const data = await res.json();
  if (!res.ok) { $('notifyError').textContent = 'Не отправлено: ' + (data.error || 'ошибка'); return; }
  $('notifyOk').textContent = 'Тестовое сообщение отправлено — проверьте Telegram ✓';
  $('tgToken').value = '';
  openNotifyRefresh();
});

$('tgClearBtn').addEventListener('click', async () => {
  if (!confirm('Отключить Telegram-уведомления?')) return;
  await fetch('/api/settings/telegram-clear', { method: 'POST' });
  $('tgToken').value = ''; $('tgChatId').value = '';
  $('notifyOk').textContent = 'Уведомления отключены.';
  openNotifyRefresh();
});

boot();
