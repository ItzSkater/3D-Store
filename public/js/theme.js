'use strict';

// Переключение темы: авто (как в системе) → светлая → тёмная.
// Выбор сохраняется в localStorage. Скрипт подключается первым в <head>,
// чтобы страница сразу рисовалась в нужной теме, без вспышки.
(function () {
  const KEY = 'theme';
  const root = document.documentElement;

  function saved() {
    try { return localStorage.getItem(KEY) || 'auto'; } catch { return 'auto'; }
  }

  function apply(mode) {
    if (mode === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);

    // Цвет строки браузера под текущую тему
    const dark =
      mode === 'dark' ||
      (mode === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#000000' : '#ffffff');

    const btn = document.getElementById('themeToggle');
    if (btn) {
      btn.textContent = mode === 'auto' ? '🌗' : mode === 'dark' ? '🌙' : '☀️';
      btn.title =
        mode === 'auto' ? 'Тема: как в системе' : mode === 'dark' ? 'Тема: тёмная' : 'Тема: светлая';
    }
  }

  // Применяем как можно раньше
  apply(saved());

  window.Theme = {
    cycle() {
      const order = ['auto', 'light', 'dark'];
      const next = order[(order.indexOf(saved()) + 1) % order.length];
      try { localStorage.setItem(KEY, next); } catch {}
      apply(next);
    },
    apply,
    current: saved,
  };

  document.addEventListener('DOMContentLoaded', () => {
    apply(saved());
    const btn = document.getElementById('themeToggle');
    if (btn) btn.addEventListener('click', () => window.Theme.cycle());
  });

  // Если тема «авто» — следим за системной
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (saved() === 'auto') apply('auto');
  });
})();
