(function () {
  'use strict';
  console.error('CRITICAL: app.js restore in progress. Please wait for next commit.');
  document.addEventListener('DOMContentLoaded', function () {
    var el = document.createElement('div');
    el.style.cssText = 'position:fixed;inset:0;background:#111;color:#fff;z-index:99999;display:flex;align-items:center;justify-content:center;font-family:system-ui;text-align:center;padding:2rem';
    el.innerHTML = '<div><h1>Restauro do app.js</h1><p>O ficheiro principal está a ser restaurado no GitHub. Recarrega em 1–2 minutos.</p></div>';
    document.body.appendChild(el);
  });
})();
