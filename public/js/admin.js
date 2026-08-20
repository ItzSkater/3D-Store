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
  const media = (p.images && p.images.length) ? p.images : (p.image ? [{ id: p.image, kind: 'image' }] : []);
  const first = media[0];
  const img = first
    ? (first.kind === 'video'
        ? `<video src="/img/${esc(first.id)}" muted loop playsinline autoplay></video>`
        : `<img src="/img/${esc(first.id)}" alt="${esc(p.name)}" />`) +
      (media.length > 1 ? `<span class="photo-count">📷 ${media.length}</span>` : '')
    : '<div class="placeholder">🧊</div>';
  const chips = (p.variants || [])
    .map((v) => {
      const stock =
        v.stock === null || v.stock === undefined
          ? ''
          : v.stock > 0
          ? ` · ${v.stock} шт`
          : ' · нет';
      return `<span class="chip${v.stock === 0 ? ' oos' : ''}">${swHtml(v.color)}${esc(v.name)}${v.extra_price ? ' +' + money(v.extra_price) : ''}${stock}</span>`;
    })
    .join('');
  return `
    <div class="card">
      <div class="thumb">${img}</div>
      <div class="body">
        <h3>${esc(p.name)} ${p.is_active ? '' : '<span class="inactive-tag">скрыта</span>'}</h3>
        <p class="desc">${esc(p.description) || '—'}</p>
        ${chips ? `<div class="chips">${chips}</div>` : ''}
        <div class="price">${
          p.sale_price !== null && p.sale_price !== undefined && p.sale_price < p.price
            ? `<span class="old-price">${money(p.price)}</span> ${money(p.sale_price)}`
            : money(p.price)
        }</div>
        <button class="btn small" data-edit="${p.id}">Редактировать</button>
      </div>
    </div>`;
}

// ---------- Модалка модели ----------
const productModal = $('productModal');

function parseColorSpec(spec) {
  try {
    const o = typeof spec === 'string' ? JSON.parse(spec) : spec;
    const colors = (o && Array.isArray(o.c) ? o.c : []).filter((x) => /^#[0-9a-fA-F]{6}$/.test(x));
    return { colors: colors.slice(0, 4), metal: !!(o && o.m) };
  } catch {
    return { colors: [], metal: false };
  }
}

function addVariantRow(name = '', extra = '', color = '', stock = null) {
  const state = parseColorSpec(color);
  const row = document.createElement('div');
  row.className = 'variant-row';
  row.innerHTML = `
    <div class="variant-main">
      <input type="text" placeholder="PLA Красный" value="${esc(name)}" data-vname />
      <input type="number" placeholder="доплата ₽" min="0" step="1" value="${extra === '' ? '' : esc(extra)}" data-vprice />
      <input type="number" placeholder="∞ шт" min="0" step="1" value="${stock === null || stock === undefined ? '' : esc(stock)}" data-vstock title="Остаток на складе (пусто — не отслеживать)" />
      <button class="btn danger small" type="button" data-vdel>✕</button>
    </div>
    <div class="variant-colors">
      <i class="sw sw-lg" data-vpreview></i>
      <span class="color-dots" data-vdots></span>
      <button type="button" class="btn ghost small" data-vaddcolor>+ цвет</button>
      <label class="metal-toggle"><input type="checkbox" data-vmetal ${state.metal ? 'checked' : ''} /> ✨ Металлик</label>
    </div>`;

  const dots = row.querySelector('[data-vdots]');
  const preview = row.querySelector('[data-vpreview]');
  const metal = row.querySelector('[data-vmetal]');

  function refresh() {
    const colors = Array.from(dots.querySelectorAll('input[type="color"]')).map((i) => i.value);
    const bg = swBg({ c: colors, m: metal.checked });
    preview.style.background = bg || 'transparent';
    preview.style.display = colors.length ? '' : 'none';
    row.querySelector('[data-vaddcolor]').style.display = colors.length >= 4 ? 'none' : '';
  }

  function addDot(hex) {
    const dot = document.createElement('span');
    dot.className = 'cdot';
    dot.innerHTML = `<input type="color" value="${/^#[0-9a-fA-F]{6}$/.test(hex) ? hex : '#4353ff'}" /><button type="button" class="cdel" title="Убрать цвет">×</button>`;
    dot.querySelector('input').addEventListener('input', refresh);
    dot.querySelector('.cdel').addEventListener('click', () => {
      dot.remove();
      refresh();
    });
    dots.appendChild(dot);
    refresh();
  }

  state.colors.forEach(addDot);
  refresh();

  row.querySelector('[data-vaddcolor]').addEventListener('click', () => addDot('#4353ff'));
  metal.addEventListener('change', refresh);
  row.querySelector('[data-vdel]').addEventListener('click', () => row.remove());
  $('variantsBox').appendChild(row);
}

function collectVariants() {
  return Array.from($('variantsBox').querySelectorAll('.variant-row'))
    .map((r) => {
      const colors = Array.from(r.querySelectorAll('[data-vdots] input[type="color"]')).map((i) => i.value);
      const metal = r.querySelector('[data-vmetal]').checked;
      const stockVal = r.querySelector('[data-vstock]').value.trim();
      return {
        name: r.querySelector('[data-vname]').value.trim(),
        extra_price: Number(r.querySelector('[data-vprice]').value) || 0,
        color: colors.length ? { c: colors, m: metal } : '',
        stock: stockVal === '' ? '' : Math.max(0, parseInt(stockVal, 10) || 0),
      };
    })
    .filter((v) => v.name);
}

let removeImages = []; // id фото, отмеченные на удаление
let editorImages = []; // текущий список фото открытой модели

function renderCurrentImages(images) {
  if (images) editorImages = images.slice();
  const box = $('currentImages');
  const list = editorImages.filter((m) => !removeImages.includes(m.id));
  if (!list.length) {
    box.innerHTML = '';
    $('imagesHint').textContent = 'Можно выбрать несколько файлов сразу. Первое фото — обложка.';
    return;
  }
  $('imagesHint').textContent = `Фото: ${list.length} из 10. Первое — обложка. ✂️ — обрезать, ✕ — убрать.`;
  box.innerHTML = list
    .map(
      (m, i) => `
      <span class="pimg${i === 0 ? ' cover' : ''}">
        ${m.kind === 'video'
          ? `<video src="/img/${esc(m.id)}" muted loop playsinline autoplay></video>`
          : `<img src="/img/${esc(m.id)}" alt="" />`}
        <button type="button" class="cdel" data-rm="${esc(m.id)}" title="Удалить">×</button>
        ${m.kind === 'video' ? '' : `<button type="button" class="ccrop" data-crop="${esc(m.id)}" title="Обрезать фото">✂️</button>`}
        ${i === 0 ? '<b class="cover-tag">обложка</b>' : ''}
      </span>`
    )
    .join('');
  box.querySelectorAll('[data-rm]').forEach((b) =>
    b.addEventListener('click', () => {
      removeImages.push(b.dataset.rm);
      renderCurrentImages();
    })
  );
  box.querySelectorAll('[data-crop]').forEach((b) =>
    b.addEventListener('click', () => openCrop(b.dataset.crop))
  );
}

// ---------- Обрезка фото ----------
const cropModal = $('cropModal');
let cropState = { imageId: null, ratio: 1, box: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } };

function drawCropBox() {
  const img = $('cropImg');
  const el = $('cropBox');
  const b = cropState.box;
  el.style.left = b.x * img.clientWidth + 'px';
  el.style.top = b.y * img.clientHeight + 'px';
  el.style.width = b.w * img.clientWidth + 'px';
  el.style.height = b.h * img.clientHeight + 'px';
}

// Вписывает рамку с нужным соотношением сторон по центру снимка
function fitBox(ratio) {
  const img = $('cropImg');
  const W = img.clientWidth || 1;
  const H = img.clientHeight || 1;
  cropState.ratio = ratio;
  if (!ratio) {
    cropState.box = { x: 0.05, y: 0.05, w: 0.9, h: 0.9 };
  } else {
    // ratio — ширина/высота в пикселях экрана
    let w = W * 0.9;
    let h = w / ratio;
    if (h > H * 0.9) {
      h = H * 0.9;
      w = h * ratio;
    }
    cropState.box = { x: (W - w) / 2 / W, y: (H - h) / 2 / H, w: w / W, h: h / H };
  }
  drawCropBox();
}

function openCrop(imageId) {
  const pid = $('pId').value;
  if (!pid) {
    $('productError').textContent = 'Сначала сохраните модель — потом её фото можно обрезать.';
    return;
  }
  cropState.imageId = imageId;
  $('cropError').textContent = '';
  const img = $('cropImg');
  img.onload = () => fitBox(1); // по умолчанию предлагаем квадрат
  img.src = '/img/' + imageId;
  cropModal.classList.add('open');
}

function closeCrop() {
  cropModal.classList.remove('open');
}

// Перетаскивание рамки и её углов (мышь + палец)
(function initCropDrag() {
  const stage = $('cropStage');
  const boxEl = $('cropBox');
  let mode = null; // 'move' | 'nw' | 'ne' | 'sw' | 'se'
  let start = null;

  function pt(e) {
    const t = e.touches ? e.touches[0] : e;
    const img = $('cropImg');
    const r = img.getBoundingClientRect();
    return { x: (t.clientX - r.left) / r.width, y: (t.clientY - r.top) / r.height };
  }

  function begin(e, m) {
    mode = m;
    start = { p: pt(e), box: { ...cropState.box } };
    e.preventDefault();
  }

  boxEl.addEventListener('mousedown', (e) => { if (!e.target.dataset.hnd) begin(e, 'move'); });
  boxEl.addEventListener('touchstart', (e) => { if (!e.target.dataset.hnd) begin(e, 'move'); }, { passive: false });
  boxEl.querySelectorAll('[data-hnd]').forEach((h) => {
    h.addEventListener('mousedown', (e) => { e.stopPropagation(); begin(e, h.dataset.hnd); });
    h.addEventListener('touchstart', (e) => { e.stopPropagation(); begin(e, h.dataset.hnd); }, { passive: false });
  });

  function move(e) {
    if (!mode) return;
    const img = $('cropImg');
    const aspectPx = cropState.ratio; // ширина/высота в пикселях
    const W = img.clientWidth || 1;
    const H = img.clientHeight || 1;
    const p = pt(e);
    const dx = p.x - start.p.x;
    const dy = p.y - start.p.y;
    const b = { ...start.box };

    if (mode === 'move') {
      b.x = Math.min(Math.max(b.x + dx, 0), 1 - b.w);
      b.y = Math.min(Math.max(b.y + dy, 0), 1 - b.h);
    } else {
      // Тянем угол: считаем в пикселях, чтобы держать пропорции
      let left = b.x * W, top = b.y * H, right = (b.x + b.w) * W, bottom = (b.y + b.h) * H;
      const px = p.x * W, py = p.y * H;
      if (mode.includes('w')) left = Math.min(px, right - 30);
      if (mode.includes('e')) right = Math.max(px, left + 30);
      if (mode.includes('n')) top = Math.min(py, bottom - 30);
      if (mode.includes('s')) bottom = Math.max(py, top + 30);

      let w = right - left;
      let h = bottom - top;
      if (aspectPx) {
        // Держим заданное соотношение, отталкиваясь от большей стороны
        if (w / h > aspectPx) w = h * aspectPx;
        else h = w / aspectPx;
        if (mode.includes('w')) left = right - w;
        if (mode.includes('n')) top = bottom - h;
      }
      // Не вылезаем за границы снимка
      left = Math.max(0, Math.min(left, W - w));
      top = Math.max(0, Math.min(top, H - h));
      w = Math.min(w, W - left);
      h = Math.min(h, H - top);

      b.x = left / W; b.y = top / H; b.w = w / W; b.h = h / H;
    }
    cropState.box = b;
    drawCropBox();
    e.preventDefault();
  }

  function end() { mode = null; }

  document.addEventListener('mousemove', move);
  document.addEventListener('touchmove', move, { passive: false });
  document.addEventListener('mouseup', end);
  document.addEventListener('touchend', end);
  stage.addEventListener('dragstart', (e) => e.preventDefault());
})();

cropModal.querySelectorAll('[data-ratio]').forEach((b) =>
  b.addEventListener('click', () => {
    cropModal.querySelectorAll('[data-ratio]').forEach((x) => x.classList.remove('primary'));
    b.classList.add('primary');
    fitBox(Number(b.dataset.ratio));
  })
);
cropModal.querySelectorAll('[data-cropclose]').forEach((el) => el.addEventListener('click', closeCrop));
cropModal.addEventListener('click', (e) => { if (e.target === cropModal) closeCrop(); });

$('cropApply').addEventListener('click', async () => {
  const pid = $('pId').value;
  const oldId = cropState.imageId;
  if (!pid || !oldId) return;
  const btn = $('cropApply');
  btn.disabled = true;
  $('cropError').textContent = '';
  try {
    const res = await fetch(`/api/products/${pid}/images/${oldId}/crop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cropState.box),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка');
    // Подменяем id фото в списке редактора
    editorImages = editorImages.map((m) => (m.id === oldId ? { id: data.image_id, kind: 'image' } : m));
    renderCurrentImages();
    closeCrop();
    loadProducts();
  } catch (e) {
    $('cropError').textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

function openProduct(p) {
  $('productError').textContent = '';
  $('variantsBox').innerHTML = '';
  $('pImages').value = '';
  $('pSquare').checked = false;
  removeImages = [];
  editorImages = [];
  if (p) {
    $('productModalTitle').textContent = 'Редактирование модели';
    $('pId').value = p.id;
    $('pName').value = p.name;
    $('pDesc').value = p.description || '';
    $('pPrice').value = p.price;
    $('pSale').value = p.sale_price === null || p.sale_price === undefined ? '' : p.sale_price;
    $('pActive').value = String(p.is_active);
    renderCurrentImages(p.images || []);
    (p.variants || []).forEach((v) => addVariantRow(v.name, v.extra_price, v.color, v.stock));
    $('deleteProductBtn').style.display = '';
  } else {
    $('productModalTitle').textContent = 'Новая модель';
    $('pId').value = '';
    $('pName').value = '';
    $('pDesc').value = '';
    $('pPrice').value = '';
    $('pSale').value = '';
    $('pActive').value = '1';
    renderCurrentImages([]);
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
  fd.append('sale_price', $('pSale').value.trim());
  fd.append('is_active', $('pActive').value);
  fd.append('variants', JSON.stringify(collectVariants()));
  fd.append('remove_images', JSON.stringify(removeImages));
  if ($('pSquare').checked) fd.append('square', '1');
  const files = Array.from($('pImages').files).slice(0, 10);
  for (const f of files) fd.append('images', f);

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
        <h4>#${o.id} · ${esc(o.product_name)} ${o.variant_name ? '· ' + swHtml(o.variant_color) + esc(o.variant_name) : ''}</h4>
        <div class="sub">${esc(o.customer_name)}${o.username ? ' (@' + esc(o.username) + ')' : ''}${o.phone ? ' · ' + esc(o.phone) : ''} · ${o.quantity} шт · ${money(o.total)}</div>
        <div class="sub">${o.address ? 'Выдача: ' + esc(o.address) + ' · ' : ''}${fmtDate(o.created_at)}</div>
        ${o.gift_name ? `<div class="sub gift-line">🎁 Положить в подарок: ${esc(o.gift_name)}</div>` : ''}
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
      <b>${esc(o.product_name)}</b> ${o.variant_name ? '· ' + swHtml(o.variant_color) + esc(o.variant_name) : ''}<br/>
      Клиент: ${esc(o.customer_name)}${o.username ? ' (@' + esc(o.username) + ')' : ''}<br/>
      ${o.phone ? 'Телефон: ' + esc(o.phone) + '<br/>' : ''}
      ${o.address ? 'Выдача: ' + esc(o.address) + '<br/>' : ''}
      Количество: ${o.quantity} · Итого: <b>${money(o.total)}</b>${o.discount_percent ? ' · скидка ' + o.discount_percent + '%' : ''} · 💵 оплата при получении
      ${o.gift_name ? '<br/>🎁 Положить в подарок: <b>' + esc(o.gift_name) + '</b>' : ''}
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

// ---------- Скидки за покупку ----------
const discountModal = $('discountModal');

async function openDiscounts() {
  $('dError').textContent = '';
  $('dPercent').value = '';
  const res = await fetch('/api/products');
  const products = res.ok ? await res.json() : [];
  const opts = products.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  $('dTrigger').innerHTML = opts;
  $('dTarget').innerHTML = opts;
  if (products[1]) $('dTarget').value = products[1].id;
  await loadDiscounts();
  discountModal.classList.add('open');
}

async function loadDiscounts() {
  const res = await fetch('/api/discounts');
  if (!res.ok) return;
  const list = await res.json();
  const box = $('dList');
  if (!list.length) {
    box.innerHTML = '<div class="empty" style="padding:26px;">Правил пока нет.</div>';
    return;
  }
  box.innerHTML = list
    .map(
      (d) => `
      <div class="order-item">
        <div class="info">
          <h4>Купил «${esc(d.trigger_name || '—')}» → скидка ${d.percent}%</h4>
          <div class="sub">на модель «${esc(d.target_name || '—')}»</div>
        </div>
        <div class="right"><button class="btn danger small" data-ddel="${d.id}">Удалить</button></div>
      </div>`
    )
    .join('');
  box.querySelectorAll('[data-ddel]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Удалить правило?')) return;
      await fetch('/api/discounts/' + b.dataset.ddel, { method: 'DELETE' });
      loadDiscounts();
    })
  );
}

$('discountBtn').addEventListener('click', openDiscounts);
discountModal.querySelectorAll('[data-discclose]').forEach((el) =>
  el.addEventListener('click', () => discountModal.classList.remove('open'))
);
discountModal.addEventListener('click', (e) => { if (e.target === discountModal) discountModal.classList.remove('open'); });

$('dAdd').addEventListener('click', async () => {
  $('dError').textContent = '';
  const res = await fetch('/api/discounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      trigger_product_id: $('dTrigger').value,
      target_product_id: $('dTarget').value,
      percent: $('dPercent').value,
    }),
  });
  const data = await res.json();
  if (!res.ok) { $('dError').textContent = data.error || 'Ошибка'; return; }
  $('dPercent').value = '';
  loadDiscounts();
});

// ---------- Подарки за сумму заказа ----------
const giftModal = $('giftModal');

async function openGifts() {
  $('gError').textContent = '';
  $('gMin').value = '';
  const res = await fetch('/api/products');
  const products = res.ok ? await res.json() : [];
  $('gProduct').innerHTML = products.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  await loadGiftList();
  giftModal.classList.add('open');
}

async function loadGiftList() {
  const res = await fetch('/api/gifts');
  if (!res.ok) return;
  const list = await res.json();
  const box = $('gList');
  if (!list.length) {
    box.innerHTML = '<div class="empty" style="padding:26px;">Подарков пока нет.</div>';
    return;
  }
  box.innerHTML = list
    .map(
      (g) => `
      <div class="order-item">
        <div class="info">
          <h4>«${esc(g.product_name)}» в подарок</h4>
          <div class="sub">при заказе от ${money(g.min_total)}</div>
        </div>
        <div class="right"><button class="btn danger small" data-gdel="${g.id}">Удалить</button></div>
      </div>`
    )
    .join('');
  box.querySelectorAll('[data-gdel]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Удалить подарок?')) return;
      await fetch('/api/gifts/' + b.dataset.gdel, { method: 'DELETE' });
      loadGiftList();
    })
  );
}

$('giftBtn').addEventListener('click', openGifts);
giftModal.querySelectorAll('[data-giftclose]').forEach((el) =>
  el.addEventListener('click', () => giftModal.classList.remove('open'))
);
giftModal.addEventListener('click', (e) => { if (e.target === giftModal) giftModal.classList.remove('open'); });

$('gAdd').addEventListener('click', async () => {
  $('gError').textContent = '';
  const res = await fetch('/api/gifts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ product_id: $('gProduct').value, min_total: $('gMin').value }),
  });
  const data = await res.json();
  if (!res.ok) { $('gError').textContent = data.error || 'Ошибка'; return; }
  $('gMin').value = '';
  loadGiftList();
});

boot();
