'use strict';

// Тема: тёмная по умолчанию (как на Linear), переключается на светлую.
// Выбор сохраняется. Скрипт стоит в <head> до отрисовки — иначе мигает фон.
(function () {
  const KEY = 'theme';
  const root = document.documentElement;

  function saved() {
    try {
      const v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : 'dark';
    } catch {
      return 'dark';
    }
  }

  function apply(mode) {
    root.setAttribute('data-theme', mode);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', mode === 'light' ? '#ffffff' : '#08090a');

    const btn = document.getElementById('themeToggle');
    if (btn) {
      btn.textContent = mode === 'light' ? '☀' : '☾';
      btn.title = mode === 'light' ? 'Светлая тема' : 'Тёмная тема';
      btn.setAttribute('aria-label', btn.title);
    }
  }

  apply(saved());

  window.Theme = {
    cycle() {
      const next = saved() === 'light' ? 'dark' : 'light';
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
})();
