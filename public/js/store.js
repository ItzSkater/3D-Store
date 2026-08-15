'use strict';

const catalogEl = document.getElementById('catalog');
const modal = document.getElementById('orderModal');
let current = { product: null };

function money(n) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' ₽';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

async function loadCatalog() {
  try {
    const res = await fetch('/api/products');
    const products = await res.json();
    if (!Array.isArray(products) || products.length === 0) {
      catalogEl.innerHTML = '<div class="empty">Пока нет доступных моделей. Загляните позже 🙂</div>';
      return;
    }
    catalogEl.innerHTML = products.map(renderCard).join('');
    catalogEl.querySelectorAll('[data-order]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const product = products.find((p) => p.id == btn.dataset.order);
        // Требуем вход в аккаунт перед заказом
        window.Auth.require(() => openOrder(product));
      });
    });
  } catch (e) {
    catalogEl.innerHTML = '<div class="empty">Не удалось загрузить каталог.</div>';
  }
}

function renderCard(p) {
  const img = p.image
    ? `<img src="/img/${esc(p.image)}" alt="${esc(p.name)}" loading="lazy" />`
    : '<div class="placeholder">🧊</div>';
  const chips = (p.variants || [])
    .slice(0, 4)
    .map((v) => `<span class="chip">${esc(v.name)}</span>`)
    .join('');
  const more = (p.variants || []).length > 4 ? `<span class="chip">+${p.variants.length - 4}</span>` : '';
  return `
    <div class="card">
      <div class="thumb">${img}</div>
      <div class="body">
        <h3>${esc(p.name)}</h3>
        <p class="desc">${esc(p.description) || 'Модель для 3D-печати'}</p>
        ${chips ? `<div class="chips">${chips}${more}</div>` : ''}
        <div class="price">${money(p.price)} <small>${p.variants && p.variants.length ? 'от базовой цены' : ''}</small></div>
        <button class="btn primary" data-order="${p.id}">Заказать</button>
      </div>
    </div>`;
}

function openOrder(product) {
  current.product = product;
  document.getElementById('orderTitle').textContent = 'Заказ: ' + product.name;
  document.getElementById('orderSummary').innerHTML =
    `<div class="notice">${esc(product.description) || 'Модель для 3D-печати'}</div>`;

  const sel = document.getElementById('variantSelect');
  if (product.variants && product.variants.length) {
    sel.innerHTML = product.variants
      .map(
        (v) =>
          `<option value="${v.id}" data-extra="${v.extra_price}">${esc(v.name)}${
            v.extra_price ? ' (+' + money(v.extra_price) + ')' : ''
          }</option>`
      )
      .join('');
    sel.style.display = '';
    sel.previousElementSibling.style.display = '';
  } else {
    sel.innerHTML = '<option value="">Без выбора</option>';
    sel.style.display = 'none';
    sel.previousElementSibling.style.display = 'none';
  }

  const acc = window.Auth.getState().user;
  document.getElementById('qty').value = 1;
  document.getElementById('custName').value = acc ? acc.display_name || acc.username : '';
  document.getElementById('custPhone').value = acc && acc.phone ? acc.phone : '';
  document.getElementById('custMessage').value = '';
  document.getElementById('orderError').textContent = '';
  updateTotal();
  modal.classList.add('open');
}

function updateTotal() {
  if (!current.product) return;
  const sel = document.getElementById('variantSelect');
  const extra = sel && sel.selectedOptions[0] ? Number(sel.selectedOptions[0].dataset.extra || 0) : 0;
  const qty = Math.max(1, parseInt(document.getElementById('qty').value, 10) || 1);
  const total = (current.product.price + extra) * qty;
  document.getElementById('totalPreview').value = money(total);
}

async function submitOrder() {
  const btn = document.getElementById('submitOrder');
  const errEl = document.getElementById('orderError');
  errEl.textContent = '';
  const name = document.getElementById('custName').value.trim();
  if (!name) {
    errEl.textContent = 'Пожалуйста, укажите ваше имя.';
    return;
  }
  const sel = document.getElementById('variantSelect');
  const payload = {
    product_id: current.product.id,
    variant_id: sel && sel.value ? sel.value : null,
    quantity: parseInt(document.getElementById('qty').value, 10) || 1,
    customer_name: name,
    phone: document.getElementById('custPhone').value.trim(),
    message: document.getElementById('custMessage').value.trim(),
  };
  btn.disabled = true;
  btn.textContent = 'Оформляем…';
  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (res.status === 401) {
      // сессия истекла — просим войти заново
      modal.classList.remove('open');
      window.Auth.require(() => openOrder(current.product));
      return;
    }
    if (!res.ok) throw new Error(data.error || 'Ошибка');
    window.location.href = '/order?token=' + data.token;
  } catch (e) {
    errEl.textContent = e.message;
    btn.disabled = false;
    btn.textContent = 'Оформить заказ';
  }
}

document.getElementById('variantSelect').addEventListener('change', updateTotal);
document.getElementById('qty').addEventListener('input', updateTotal);
document.getElementById('submitOrder').addEventListener('click', submitOrder);
modal.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', () => modal.classList.remove('open')));
modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('open'); });

window.Auth.refresh();
loadCatalog();
