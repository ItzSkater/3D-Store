'use strict';

// Общий модуль клиентской авторизации (юзернейм + пароль, без email).
window.Auth = (function () {
  let state = { owner: false, user: null };
  let mode = 'login';
  let onSuccess = null;

  const modal = document.getElementById('authModal');

  async function refresh() {
    try {
      const res = await fetch('/api/me');
      const data = await res.json();
      state = { owner: !!data.owner, user: data.user || null };
    } catch {
      state = { owner: false, user: null };
    }
    renderAuthArea();
    return state;
  }

  function renderAuthArea() {
    const area = document.getElementById('authArea');
    if (!area) return;
    if (state.user) {
      area.innerHTML =
        `<span class="chip" style="margin-right:6px;">👤 ${escapeHtml(state.user.display_name || state.user.username)}</span>` +
        `<button class="btn ghost small" id="logoutBtn">Выйти</button>`;
      const btn = document.getElementById('logoutBtn');
      if (btn) btn.addEventListener('click', logout);
    } else {
      area.innerHTML = `<button class="btn small" id="loginBtn">Войти</button>`;
      const btn = document.getElementById('loginBtn');
      if (btn) btn.addEventListener('click', () => open('login'));
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function open(m, cb) {
    if (!modal) return;
    onSuccess = cb || null;
    setMode(m || 'login');
    document.getElementById('authError').textContent = '';
    document.getElementById('authUsername').value = '';
    document.getElementById('authPassword').value = '';
    const d = document.getElementById('authDisplay');
    const p = document.getElementById('authPhone');
    if (d) d.value = '';
    if (p) p.value = '';
    modal.classList.add('open');
    document.getElementById('authUsername').focus();
  }

  function close() {
    if (modal) modal.classList.remove('open');
  }

  function setMode(m) {
    mode = m;
    document.getElementById('authTitle').textContent = m === 'login' ? 'Вход в аккаунт' : 'Регистрация';
    document.getElementById('authSubmit').textContent = m === 'login' ? 'Войти' : 'Создать аккаунт';
    document.getElementById('regExtra').style.display = m === 'register' ? '' : 'none';
    modal.querySelectorAll('[data-auth-tab]').forEach((t) => {
      t.classList.toggle('active', t.dataset.authTab === m);
    });
  }

  async function submit() {
    const err = document.getElementById('authError');
    err.textContent = '';
    const username = document.getElementById('authUsername').value.trim();
    const password = document.getElementById('authPassword').value;
    if (!username || !password) {
      err.textContent = 'Заполните юзернейм и пароль.';
      return;
    }
    const btn = document.getElementById('authSubmit');
    btn.disabled = true;
    try {
      let res, data;
      if (mode === 'register') {
        res = await fetch('/api/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username,
            password,
            display_name: document.getElementById('authDisplay').value.trim(),
            phone: document.getElementById('authPhone').value.trim(),
          }),
        });
      } else {
        res = await fetch('/api/user-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
      }
      data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка');
      state.user = data.user;
      renderAuthArea();
      close();
      // Страница может обновить данные под вошедшего клиента (напр. скидки)
      if (typeof window.onAuthLogin === 'function') await window.onAuthLogin(state.user);
      const cb = onSuccess;
      onSuccess = null;
      if (cb) cb(state.user);
    } catch (e) {
      err.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  }

  async function logout() {
    await fetch('/api/user-logout', { method: 'POST' });
    state.user = null;
    renderAuthArea();
    if (typeof window.onAuthLogout === 'function') window.onAuthLogout();
  }

  // Требовать вход: если пользователь есть — сразу cb, иначе открыть модалку.
  function require(cb) {
    if (state.user) return cb(state.user);
    open('login', cb);
  }

  function getState() {
    return state;
  }

  // Навешиваем обработчики модалки (если она есть на странице)
  if (modal) {
    modal.querySelectorAll('[data-auth-tab]').forEach((t) =>
      t.addEventListener('click', () => {
        document.getElementById('authError').textContent = '';
        setMode(t.dataset.authTab);
      })
    );
    modal.querySelectorAll('[data-auth-close]').forEach((el) => el.addEventListener('click', close));
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    document.getElementById('authSubmit').addEventListener('click', submit);
    modal.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  }

  return { refresh, open, close, require, getState, logout };
})();
