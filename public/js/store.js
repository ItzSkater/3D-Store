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

// Фон для образца цвета филамента: {"c":["#hex",...],"m":bool}
// несколько цветов = градиент, m = металлик (диагональный блик)
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
  const cover = (p.images && p.images[0]) || p.image;
  const img = cover
    ? `<img src="/img/${esc(cover)}" alt="${esc(p.name)}" loading="lazy" />${
        p.images && p.images.length > 1 ? `<span class="photo-count">📷 ${p.images.length}</span>` : ''
      }`
    : '<div class="placeholder">🧊</div>';
  const chips = (p.variants || [])
    .slice(0, 4)
    .map((v) => `<span class="chip">${swHtml(v.color)}${esc(v.name)}</span>`)
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

function galleryHtml(p) {
  const imgs = p.images || [];
  if (!imgs.length) return '';
  const thumbs =
    imgs.length > 1
      ? `<div class="gal-thumbs">${imgs
          .map((id, i) => `<img src="/img/${esc(id)}" data-gal="${i}" class="${i === 0 ? 'active' : ''}" alt="" />`)
          .join('')}</div>`
      : '';
  return `<div class="gallery"><img class="gal-main" id="galMain" src="/img/${esc(imgs[0])}" alt="" />${thumbs}</div>`;
}

function openOrder(product) {
  current.product = product;
  document.getElementById('orderTitle').textContent = 'Заказ: ' + product.name;
  document.getElementById('orderSummary').innerHTML =
    galleryHtml(product) +
    `<div class="notice">${esc(product.description) || 'Модель для 3D-печати'}</div>`;
  document.querySelectorAll('#orderSummary [data-gal]').forEach((t) =>
    t.addEventListener('click', () => {
      document.getElementById('galMain').src = t.src;
      document.querySelectorAll('#orderSummary [data-gal]').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
    })
  );

  const box = document.getElementById('variantOptions');
  const lbl = document.getElementById('variantLabel');
  current.variant = null;
  if (product.variants && product.variants.length) {
    box.innerHTML = product.variants
      .map((v) => {
        const tracked = v.stock !== null && v.stock !== undefined;
        const oos = tracked && v.stock <= 0;
        const stockNote = oos
          ? '<span class="vstock oos">нет в наличии</span>'
          : tracked
          ? `<span class="vstock">в наличии: ${v.stock}</span>`
          : '';
        return `
        <button type="button" class="variant-option${oos ? ' oos' : ''}" data-vid="${v.id}" data-extra="${v.extra_price}" data-stock="${tracked ? v.stock : ''}" ${oos ? 'disabled' : ''}>
          ${swHtml(v.color, 'sw-lg')}
          <span>${esc(v.name)}</span>
          <span class="vmeta">${stockNote}<span class="vprice">${v.extra_price ? '+' + money(v.extra_price) : ''}</span></span>
        </button>`;
      })
      .join('');
    box.querySelectorAll('.variant-option:not(.oos)').forEach((b) =>
      b.addEventListener('click', () => {
        box.querySelectorAll('.variant-option').forEach((x) => x.classList.remove('selected'));
        b.classList.add('selected');
        current.variant = {
          id: b.dataset.vid,
          extra: Number(b.dataset.extra) || 0,
          stock: b.dataset.stock === '' ? null : Number(b.dataset.stock),
        };
        updateTotal();
      })
    );
    // Выбираем первый доступный вариант по умолчанию
    const firstAvail = box.querySelector('.variant-option:not(.oos)');
    if (firstAvail) firstAvail.click();
    else document.getElementById('orderError').textContent = 'К сожалению, всё распродано. Напишите продавцу в чате.';
    box.style.display = '';
    lbl.style.display = '';
  } else {
    box.innerHTML = '';
    box.style.display = 'none';
    lbl.style.display = 'none';
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
  const extra = current.variant ? current.variant.extra : 0;
  const qtyInput = document.getElementById('qty');
  let qty = Math.max(1, parseInt(qtyInput.value, 10) || 1);
  // Не даём заказать больше, чем есть на складе
  const stock = current.variant ? current.variant.stock : null;
  if (stock !== null && stock !== undefined && qty > stock) {
    qty = stock;
    qtyInput.value = stock;
  }
  qtyInput.max = stock !== null && stock !== undefined ? stock : '';
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
  if (current.product.variants && current.product.variants.length && !current.variant) {
    errEl.textContent = 'Выберите вариант филамента.';
    return;
  }
  const payload = {
    product_id: current.product.id,
    variant_id: current.variant ? current.variant.id : null,
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

document.getElementById('qty').addEventListener('input', updateTotal);
document.getElementById('submitOrder').addEventListener('click', submitOrder);
modal.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', () => modal.classList.remove('open')));
modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('open'); });

window.Auth.refresh();
loadCatalog();
