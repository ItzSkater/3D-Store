'use strict';

const catalogEl = document.getElementById('catalog');
const modal = document.getElementById('orderModal');
let current = { product: null };
let lastProducts = [];

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

// Итоговая цена: сначала акционная цена модели, затем персональная скидка
function priceOf(p) {
  const base = p.sale_price !== null && p.sale_price !== undefined && p.sale_price < p.price
    ? p.sale_price
    : p.price;
  const d = Number(p.discount) || 0;
  return Math.round(base * (100 - d)) / 100;
}
function priceInfo(p) {
  const final = priceOf(p);
  const off = p.price > 0 ? Math.round((1 - final / p.price) * 100) : 0;
  return { final, off, discounted: final < p.price };
}

let gifts = [];

function skeletons(n) {
  return Array.from({ length: n })
    .map(() => '<div class="skeleton"><div class="sk-img"></div><div class="sk-line"></div><div class="sk-line short"></div></div>')
    .join('');
}

async function loadCatalog() {
  if (!lastProducts.length) catalogEl.innerHTML = skeletons(3);
  try {
    const res = await fetch('/api/products');
    const products = await res.json();
    if (!Array.isArray(products) || products.length === 0) {
      catalogEl.innerHTML = '<div class="empty">Пока нет доступных моделей. Загляните позже 🙂</div>';
      return;
    }
    lastProducts = products;
    renderGiftBar();
    catalogEl.innerHTML = products.map(renderCard).join('');
    catalogEl.querySelectorAll('.card .thumb').forEach(initSlider);
    catalogEl.querySelectorAll('[data-card]').forEach(initExpand);
    catalogEl.querySelectorAll('[data-order]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.order;
        // Требуем вход в аккаунт перед заказом
        window.Auth.require(() => {
          // после входа каталог уже перезагружен — берём цену с учётом скидки
          const fresh = lastProducts.find((p) => p.id == id);
          openOrder(fresh || products.find((p) => p.id == id));
        });
      });
    });
  } catch (e) {
    catalogEl.innerHTML = '<div class="empty">Не удалось загрузить каталог.</div>';
  }
}

// Один слайд галереи: фото или короткое видео (Live Photo/GIF-ролик)
function mediaHtml(m, cls) {
  const id = esc(m.id);
  if (m.kind === 'video') {
    return `<video class="${cls}" src="/img/${id}" autoplay loop muted playsinline preload="metadata"></video>`;
  }
  return `<img class="${cls}" src="/img/${id}" alt="${esc(m.alt || 'Фото модели')}" loading="lazy" />`;
}

function renderCard(p) {
  const imgs = (p.images && p.images.length ? p.images : p.image ? [{ id: p.image, kind: 'image' }] : []);
  const multi = imgs.length > 1;
  const media = imgs.length
    ? imgs.map((m, i) => mediaHtml({ ...m, alt: p.name }, 'slide' + (i === 0 ? ' on' : ''))).join('') +
      (multi
        ? `<button type="button" class="snav prev" data-nav="-1" aria-label="Предыдущее фото">‹</button>` +
          `<button type="button" class="snav next" data-nav="1" aria-label="Следующее фото">›</button>` +
          `<div class="sdots">${imgs.map((_, i) => `<i class="${i === 0 ? 'on' : ''}"></i>`).join('')}</div>`
        : '')
    : '<div class="placeholder">🧊</div>';

  const chips = (p.variants || [])
    .slice(0, 4)
    .map((v) => `<span class="chip">${swHtml(v.color)}${esc(v.name)}</span>`)
    .join('');
  const more = (p.variants || []).length > 4 ? `<span class="chip">+${p.variants.length - 4}</span>` : '';

  // Цена с учётом акции и персональной скидки
  const pi = priceInfo(p);
  const extra = (p.variants || []).some((v) => Number(v.extra_price) > 0);
  const priceHtml = pi.discounted
    ? `<span class="old-price">${money(p.price)}</span> ${money(pi.final)}`
    : money(p.price);

  return `
    <div class="card" data-card="${p.id}">
      <div class="thumb">${media}${pi.off > 0 ? `<span class="sale-badge">−${pi.off}%</span>` : ''}</div>
      <div class="body">
        <h3>${esc(p.name)}</h3>
        <p class="desc">${esc(p.description) || 'Модель для 3D-печати'}</p>
        ${chips ? `<div class="chips">${chips}${more}</div>` : ''}
        <div class="price">${priceHtml}${extra ? ' <small>+ доплата за цвет</small>' : ''}</div>
        <button type="button" class="expand-hint" data-hint aria-expanded="false">Рассмотреть подробнее</button>
        <button class="btn primary" data-order="${p.id}">Заказать</button>
      </div>
    </div>`;
}

// Клик по карточке (но не по кнопке и не по фото) разворачивает её крупнее
function setHint(card, open) {
  const h = card.querySelector('[data-hint]');
  if (!h) return;
  h.textContent = open ? 'Свернуть' : 'Рассмотреть подробнее';
  h.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function toggleCard(card) {
  const willOpen = !card.classList.contains('expanded');
  catalogEl.querySelectorAll('.card.expanded').forEach((c) => {
    c.classList.remove('expanded');
    setHint(c, false);
  });
  if (willOpen) {
    card.classList.add('expanded');
    setHint(card, true);
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function initExpand(card) {
  // Мышью — клик по любому месту карточки, кроме кнопки заказа и фото
  card.addEventListener('click', (e) => {
    if (e.target.closest('[data-order], .thumb')) return;
    toggleCard(card);
  });
}

function initSlider(thumb) {
  const slides = thumb.querySelectorAll('.slide');
  if (slides.length < 2) return;
  const dots = thumb.querySelectorAll('.sdots i');
  let idx = 0;
  function show(i) {
    idx = (i + slides.length) % slides.length;
    slides.forEach((s, k) => {
      s.classList.toggle('on', k === idx);
      if (s.tagName === 'VIDEO') k === idx ? s.play().catch(() => {}) : s.pause();
    });
    dots.forEach((d, k) => d.classList.toggle('on', k === idx));
  }
  thumb.querySelectorAll('.snav').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      show(idx + Number(b.dataset.nav));
    })
  );
  // Свайп пальцем
  let x0 = null;
  thumb.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  thumb.addEventListener(
    'touchend',
    (e) => {
      if (x0 === null) return;
      const dx = e.changedTouches[0].clientX - x0;
      if (Math.abs(dx) > 40) show(idx + (dx < 0 ? 1 : -1));
      x0 = null;
    },
    { passive: true }
  );
}

function galleryHtml(p) {
  const imgs = p.images || [];
  if (!imgs.length) return '';
  const thumbs =
    imgs.length > 1
      ? `<div class="gal-thumbs">${imgs
          .map(
            (m, i) =>
              `<span class="gal-th${i === 0 ? ' active' : ''}" data-gal="${i}" data-id="${esc(m.id)}" data-kind="${m.kind}">` +
              (m.kind === 'video'
                ? `<video src="/img/${esc(m.id)}" muted playsinline preload="metadata"></video><i class="play">▶</i>`
                : `<img src="/img/${esc(m.id)}" alt="" />`) +
              `</span>`
          )
          .join('')}</div>`
      : '';
  return `<div class="gallery"><div class="gal-main" id="galMain">${mediaHtml({ ...imgs[0], alt: p.name }, 'gal-media on')}</div>${thumbs}</div>`;
}

function openOrder(product) {
  current.product = product;
  document.getElementById('orderTitle').textContent = 'Заказ: ' + product.name;
  const pi = priceInfo(product);
  const priceLine = pi.discounted
    ? `<span class="old-price">${money(product.price)}</span> <b>${money(pi.final)}</b> <span class="save">выгода ${money(product.price - pi.final)}</span>`
    : `<b>${money(product.price)}</b>`;
  document.getElementById('orderSummary').innerHTML =
    galleryHtml(product) +
    `<div class="notice">${esc(product.description) || 'Модель для 3D-печати'}</div>` +
    `<div class="order-price">${priceLine} <small>за штуку</small></div>`;
  document.querySelectorAll('#orderSummary [data-gal]').forEach((t) =>
    t.addEventListener('click', () => {
      const main = document.getElementById('galMain');
      main.innerHTML = mediaHtml({ id: t.dataset.id, kind: t.dataset.kind }, 'gal-media on');
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
  const base = current.product.sale_price !== null && current.product.sale_price !== undefined
    && current.product.sale_price < current.product.price
    ? current.product.sale_price
    : current.product.price;
  // Не даём заказать больше, чем есть на складе
  const stock = current.variant ? current.variant.stock : null;
  if (stock !== null && stock !== undefined && qty > stock) {
    qty = stock;
    qtyInput.value = stock;
  }
  qtyInput.max = stock !== null && stock !== undefined ? stock : '';
  const d = Number(current.product.discount) || 0;
  const unit = Math.round((base + extra) * (100 - d)) / 100;
  const total = unit * qty;
  document.getElementById('totalPreview').value = money(total) + (d ? ` (−${d}%)` : '');
  const gn = document.getElementById('giftNote');
  if (gn) gn.innerHTML = giftHint(total);
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

// После входа/регистрации перезагружаем каталог — появятся персональные скидки
// Полоса с подарками за сумму заказа
async function loadGifts() {
  try {
    const res = await fetch('/api/gifts');
    gifts = res.ok ? await res.json() : [];
  } catch {
    gifts = [];
  }
  renderGiftBar();
}

function renderGiftBar() {
  const box = document.getElementById('giftBar');
  if (!box) return;
  if (!gifts.length) { box.innerHTML = ''; return; }
  box.innerHTML = gifts
    .map(
      (g) => `
      <div class="gift-item">
        ${g.image ? `<img src="/img/${esc(g.image)}" alt="${esc(g.product_name)}" />` : '<span class="gift-emoji">🎁</span>'}
        <div>
          <b>${esc(g.product_name)}</b> в подарок
          <span>при заказе от ${money(g.min_total)}</span>
        </div>
      </div>`
    )
    .join('');
}

// Сколько осталось до подарка при текущей сумме
function giftHint(total) {
  if (!gifts.length) return '';
  const earned = gifts.filter((g) => g.min_total <= total).sort((a, b) => b.min_total - a.min_total)[0];
  const next = gifts.filter((g) => g.min_total > total).sort((a, b) => a.min_total - b.min_total)[0];
  const got = earned ? `<div class="gift-note ok">🎁 Подарок: <b>${esc(earned.product_name)}</b></div>` : '';
  if (!next) return got;
  const left = next.min_total - total;
  const from = earned ? earned.min_total : 0;
  // Полоса растёт от предыдущего порога к следующему, а не от нуля
  const pct = Math.max(0, Math.min(100, Math.round(((total - from) / (next.min_total - from)) * 100)));
  return (
    got +
    `<div class="gift-note">
      ${earned ? 'До следующего подарка' : 'До подарка'} «${esc(next.product_name)}» не хватает <b>${money(left)}</b>
      <span class="gift-bar"><i style="width:${pct}%"></i></span>
    </div>`
  );
}

window.onAuthLogin = () => loadCatalog();
window.onAuthLogout = () => loadCatalog();

window.Auth.refresh();
loadCatalog();
loadGifts();
