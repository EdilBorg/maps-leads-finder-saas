(function () {
  'use strict';
  const titles = { dashboard: 'Dashboard', search: 'Nova pesquisa', results: 'Resultados', history: 'Histórico', leads: 'Leads guardados', settings: 'Configurações' };
  let currentResults = [], currentSearchMeta = null, csrfToken = null;
  const $ = (s, r) => (r || document).querySelector(s);
  const $all = (s, r) => Array.from((r || document).querySelectorAll(s));
  function esc(s) { return s == null ? '' : String(s); }
  async function ensureCsrf() {
    if (csrfToken) return csrfToken;
    const res = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
    if (!res.ok) throw new Error('CSRF');
    const data = await res.json();
    csrfToken = data.csrfToken;
    return csrfToken;
  }
  async function api(path, options = {}) {
    const opts = { credentials: 'same-origin', headers: { Accept: 'application/json', ...(options.headers || {}) }, ...options };
    if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, opts);
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { res, data };
  }
  function navigate(view) {
    $all('.view').forEach((el) => el.classList.remove('active'));
    const section = $('#view-' + view);
    if (section) section.classList.add('active');
    $all('.nav-item').forEach((btn) => {
      const active = btn.getAttribute('data-view') === view;
      btn.classList.toggle('active', active);
      if (active) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });
    const title = $('#topbar-title');
    if (title) title.textContent = titles[view] || 'Maps Leads Finder';
    try { location.hash = view; } catch (_) {}
    const sidebar = $('#sidebar'), overlay = $('#sidebar-overlay');
    if (sidebar) sidebar.classList.remove('open');
    if (overlay) { overlay.classList.remove('open'); overlay.setAttribute('aria-hidden', 'true'); }
    if (view === 'dashboard') loadDashboard();
    if (view === 'history') loadHistory();
    if (view === 'leads') loadLeads();
    if (view === 'results') renderResultsState();
    if (view === 'settings') loadSettings();
  }
  function initModalities() {
    const grid = $('#modality-grid');
    if (!grid) return;
    $all('.modality-card', grid).forEach((card) => {
      const input = card.querySelector('input[type="radio"]');
      card.addEventListener('click', (e) => {
        e.preventDefault();
        $all('.modality-card', grid).forEach((c) => c.classList.remove('selected'));
        card.classList.add('selected');
        if (input) input.checked = true;
      });
    });
  }
  function selectedModality() {
    const checked = document.querySelector('input[name="modality"]:checked');
    return checked && checked.value === 'expanded' ? 'expanded' : 'standard';
  }
  function setStatus(msg, isError) {
    const el = $('#search-status');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = isError ? 'var(--color-coral-red)' : 'var(--color-fog)';
  }
  function renderResultsState() {
    const body = $('#results-body'), empty = $('#results-empty'), count = $('#results-count');
    if (!body) return;
    body.innerHTML = '';
    if (!currentResults.length) {
      if (empty) {
        empty.hidden = false;
        empty.textContent = (currentSearchMeta && currentSearchMeta.message) || 'Sem resultados para mostrar.';
      }
      if (count) count.textContent = '0 resultados';
      return;
    }
    if (empty) empty.hidden = true;
    if (count) count.textContent = currentResults.length + ' resultado' + (currentResults.length === 1 ? '' : 's');
    const frag = document.createDocumentFragment();
    currentResults.forEach((r) => {
      const tr = document.createElement('tr');
      const tdCheck = document.createElement('td');
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.className = 'result-check'; cb.value = r.id || '';
      tdCheck.appendChild(cb);
      tr.appendChild(tdCheck);
      function cell(text) { const td = document.createElement('td'); td.textContent = esc(text == null ? '—' : text); return td; }
      tr.appendChild(cell(r.name));
      tr.appendChild(cell(r.address));
      tr.appendChild(cell(r.phone));
      tr.appendChild(cell(r.email));
      tr.appendChild(cell(r.website));
      tr.appendChild(cell(r.rating != null ? r.rating : '—'));
      frag.appendChild(tr);
    });
    body.appendChild(frag);
  }
  async function submitSearch(ev) {
    ev.preventDefault();
    const query = ($('#query') || {}).value || '';
    const location = ($('#location') || {}).value || '';
    const limit = parseInt(($('#limit') || {}).value || '100', 10);
    const minRating = ($('#min-rating') || {}).value || '';
    const hasPhone = !!document.querySelector('input[name="hasPhone"]:checked');
    const hasEmail = !!document.querySelector('input[name="hasEmail"]:checked');
    const noWebsite = !!document.querySelector('input[name="noWebsite"]:checked');
    const minReviews = !!document.querySelector('input[name="minReviews"]:checked');
    if (!String(query).trim() || !String(location).trim()) { setStatus('Preenche categoria e localização.', true); return; }
    const btn = $('#btn-search');
    if (btn) btn.disabled = true;
    setStatus('A pesquisar…');
    try {
      const token = await ensureCsrf();
      const { res, data } = await api('/api/searches', {
        method: 'POST',
        headers: { 'X-CSRF-Token': token },
        body: { query: String(query).trim(), location: String(location).trim(), modality: selectedModality(), limit, minRating, hasPhone, hasEmail, noWebsite, minReviews },
      });
      if (res.status === 401) { setStatus('Inicia sessão para pesquisar.', true); return; }
      if (res.status === 403 && data && data.code === 'EMAIL_NOT_VERIFIED') { setStatus('Verifica o teu email antes de pesquisar.', true); return; }
      if (!res.ok) { setStatus((data && data.error) || 'Falha na pesquisa.', true); return; }
      currentResults = data.results || [];
      currentSearchMeta = { searchId: data.searchId, status: data.status, outcome: data.outcome, message: data.message };
      setStatus(data.outcome === 'results' ? currentResults.length + ' resultado(s).' : data.message || '');
      renderResultsState();
      navigate('results');
    } catch (_) {
      setStatus('Não foi possível realizar a pesquisa. Tenta novamente.', true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }
  function formatDate(v) {
    if (!v) return '—';
    try { return new Date(v).toLocaleString('pt-PT'); } catch (_) { return String(v); }
  }
  async function loadDashboard() {
    const { res, data } = await api('/api/searches/dashboard');
    if (!res.ok) {
      ['stat-searches', 'stat-results', 'stat-leads'].forEach((id) => { const el = $('#' + id); if (el) el.textContent = '—'; });
      const empty = $('#dashboard-recent-empty');
      if (empty) {
        empty.hidden = false;
        empty.textContent = res.status === 401 ? 'Inicia sessão para ver a atividade da conta.' : res.status === 403 ? 'Verifica o email para aceder aos dados da conta.' : 'Não foi possível carregar o dashboard.';
      }
      return;
    }
    if ($('#stat-searches')) $('#stat-searches').textContent = String(data.searchesCount);
    if ($('#stat-results')) $('#stat-results').textContent = String(data.resultsCount);
    if ($('#stat-leads')) $('#stat-leads').textContent = String(data.savedLeadsCount);
    const box = $('#dashboard-recent');
    if (!box) return;
    box.innerHTML = '';
    if (!data.recentSearches || !data.recentSearches.length) {
      const p = document.createElement('p'); p.className = 'empty-hint'; p.textContent = 'Ainda não existem pesquisas.'; box.appendChild(p); return;
    }
    const table = document.createElement('table'); table.className = 'data-table';
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>Categoria</th><th>Localização</th><th>Resultados</th><th>Estado</th><th>Data</th></tr>';
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    data.recentSearches.forEach((item) => {
      const tr = document.createElement('tr'); tr.style.cursor = 'pointer';
      tr.addEventListener('click', () => openSearch(item.id));
      [item.query, item.location, item.resultsCount, item.status, formatDate(item.createdAt)].forEach((val, idx) => {
        const td = document.createElement('td');
        if (idx === 3) { const pill = document.createElement('span'); pill.className = 'status-pill ' + esc(item.status); pill.textContent = esc(item.status); td.appendChild(pill); }
        else td.textContent = esc(val == null ? '—' : val);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody); box.appendChild(table);
  }
  async function loadHistory() {
    const body = $('#history-body'); if (!body) return; body.innerHTML = '';
    const { res, data } = await api('/api/searches?limit=50');
    if (!res.ok) {
      const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 5;
      td.textContent = res.status === 401 ? 'Inicia sessão para ver o histórico.' : 'Não foi possível carregar o histórico.';
      tr.appendChild(td); body.appendChild(tr); return;
    }
    if (!data.items.length) {
      const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 5; td.textContent = 'Sem pesquisas registadas.'; tr.appendChild(td); body.appendChild(tr); return;
    }
    data.items.forEach((item) => {
      const tr = document.createElement('tr'); tr.style.cursor = 'pointer';
      tr.addEventListener('click', () => openSearch(item.id));
      [item.query, item.location, item.resultsCount, item.status, formatDate(item.createdAt)].forEach((val, idx) => {
        const td = document.createElement('td');
        if (idx === 3) { const pill = document.createElement('span'); pill.className = 'status-pill ' + esc(item.status); pill.textContent = esc(item.status); td.appendChild(pill); }
        else td.textContent = esc(val == null ? '—' : val);
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
  }
  async function openSearch(id) {
    const { res, data } = await api('/api/searches/' + id + '/results');
    if (!res.ok) return;
    currentResults = data.results || [];
    currentSearchMeta = { searchId: id, status: data.search && data.search.status };
    renderResultsState();
    navigate('results');
  }
  async function loadLeads() {
    const body = $('#leads-body'); if (!body) return; body.innerHTML = '';
    const { res, data } = await api('/api/searches/leads/saved');
    if (!res.ok) {
      const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 5;
      td.textContent = res.status === 401 ? 'Inicia sessão para ver leads guardados.' : 'Não foi possível carregar leads.';
      tr.appendChild(td); body.appendChild(tr); return;
    }
    if (!data.items.length) {
      const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 5; td.textContent = 'Ainda não guardaste leads.'; tr.appendChild(td); body.appendChild(tr); return;
    }
    data.items.forEach((item) => {
      const tr = document.createElement('tr');
      [item.name, item.address, item.phone, item.email, formatDate(item.createdAt)].forEach((val) => {
        const td = document.createElement('td'); td.textContent = esc(val == null ? '—' : val); tr.appendChild(td);
      });
      body.appendChild(tr);
    });
  }
  async function saveSelectedLeads() {
    const ids = $all('.result-check:checked').map((c) => c.value).filter(Boolean);
    if (!ids.length) { setStatus('Seleciona resultados para guardar.', true); return; }
    try {
      const token = await ensureCsrf();
      const { res, data } = await api('/api/searches/leads/save', { method: 'POST', headers: { 'X-CSRF-Token': token }, body: { resultIds: ids } });
      if (!res.ok) { setStatus((data && data.error) || 'Falha ao guardar.', true); return; }
      setStatus(((data.saved || []).length) + ' lead(s) guardado(s).');
    } catch (_) { setStatus('Falha ao guardar leads.', true); }
  }
  let currentUser = null;
  let authState = 'loading';

  function setAuthState(state) {
    authState = state;
    const actions = document.querySelector('.topbar-actions');
    if (actions) actions.setAttribute('data-auth-state', state);
  }

  function setGuestUi() {
    currentUser = null;
    setAuthState('guest');
    const guest = document.getElementById('guest-actions');
    const user = document.getElementById('user-actions');
    if (guest) guest.hidden = false;
    if (user) user.hidden = true;
    const badge = document.getElementById('auth-badge');
    if (badge) { badge.textContent = ''; badge.removeAttribute('title'); }
  }

  function setAuthedUi(user) {
    currentUser = user;
    setAuthState('authenticated');
    const guest = document.getElementById('guest-actions');
    const userBox = document.getElementById('user-actions');
    if (guest) guest.hidden = true;
    if (userBox) userBox.hidden = false;
    const badge = document.getElementById('auth-badge');
    if (badge && user) {
      badge.textContent = user.emailVerified ? user.name : user.name + ' (email por verificar)';
      badge.title = user.email || '';
    }
    const logout = document.getElementById('btn-logout');
    if (logout) {
      logout.onclick = async () => {
        try {
          const token = await ensureCsrf();
          await fetch('/api/auth/logout', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'X-CSRF-Token': token, 'Content-Type': 'application/json' },
            body: '{}',
          });
        } catch (_) {}
        window.location.href = '/pages/login.html';
      };
    }
  }

  function setAuthErrorUi() {
    setAuthState('error');
    const guest = document.getElementById('guest-actions');
    const user = document.getElementById('user-actions');
    if (guest) guest.hidden = true;
    if (user) user.hidden = true;
  }

  async function refreshAuthUi() {
    setAuthState('loading');
    const guest = document.getElementById('guest-actions');
    const user = document.getElementById('user-actions');
    if (guest) guest.hidden = true;
    if (user) user.hidden = true;
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (res.status === 401) {
        setGuestUi();
        return;
      }
      if (!res.ok) {
        setAuthErrorUi();
        return;
      }
      const data = await res.json();
      if (data && data.user) setAuthedUi(data.user);
      else setGuestUi();
    } catch (_) {
      setAuthErrorUi();
    }
  }

  function loadSettings() {
    const nameEl = document.getElementById('settings-name');
    const emailEl = document.getElementById('settings-email');
    const verEl = document.getElementById('settings-verified');
    if (!currentUser) {
      if (nameEl) nameEl.textContent = '—';
      if (emailEl) emailEl.textContent = '—';
      if (verEl) verEl.textContent = authState === 'error'
        ? 'Não foi possível verificar a sessão.'
        : 'Inicie sessão para ver os dados da conta.';
      return;
    }
    if (nameEl) nameEl.textContent = currentUser.name || '—';
    if (emailEl) emailEl.textContent = currentUser.email || '—';
    if (verEl) verEl.textContent = currentUser.emailVerified ? 'Confirmado' : 'Por confirmar';
  }

  function initChangePassword() {
    const showBtn = document.getElementById('btn-show-change-password');
    const form = document.getElementById('change-password-form');
    const cancelBtn = document.getElementById('btn-cancel-change-password');
    const err = document.getElementById('change-password-error');
    const ok = document.getElementById('change-password-ok');
    const submitBtn = document.getElementById('btn-change-password');

    function hideMessages() {
      if (err) { err.classList.remove('visible'); err.textContent = ''; }
      if (ok) { ok.classList.remove('visible'); ok.textContent = ''; }
    }

    if (showBtn && form) {
      showBtn.addEventListener('click', () => {
        form.hidden = false;
        showBtn.hidden = true;
        hideMessages();
      });
    }
    if (cancelBtn && form && showBtn) {
      cancelBtn.addEventListener('click', () => {
        form.hidden = true;
        showBtn.hidden = false;
        form.reset();
        hideMessages();
      });
    }
    document.querySelectorAll('.toggle-password').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-target');
        const input = document.getElementById(id);
        if (!input) return;
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.textContent = show ? 'Ocultar' : 'Mostrar';
      });
    });
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        hideMessages();
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = 'A guardar…';
        }
        try {
          const token = await ensureCsrf();
          const { res, data } = await api('/api/auth/change-password', {
            method: 'POST',
            headers: { 'X-CSRF-Token': token },
            body: {
              currentPassword: (document.getElementById('current-password') || {}).value || '',
              newPassword: (document.getElementById('new-password') || {}).value || '',
              newPasswordConfirm: (document.getElementById('new-password-confirm') || {}).value || '',
            },
          });
          if (res.status === 401) {
            if (err) {
              err.textContent = 'Sessão expirada. Inicie sessão novamente.';
              err.classList.add('visible');
            }
            setTimeout(() => { window.location.href = '/pages/login.html'; }, 1000);
            return;
          }
          if (res.status === 403) {
            if (err) {
              err.textContent = (data && data.error) || 'Pedido rejeitado (CSRF ou permissões).';
              err.classList.add('visible');
            }
            return;
          }
          if (!res.ok) {
            if (err) {
              err.textContent = (data && data.error) || 'Não foi possível alterar a palavra-passe.';
              err.classList.add('visible');
            }
            return;
          }
          if (ok) {
            ok.textContent = (data && data.message) || 'Palavra-passe atualizada.';
            ok.classList.add('visible');
          }
          setTimeout(() => { window.location.href = '/pages/login.html'; }, 1200);
        } catch (_) {
          if (err) {
            err.textContent = 'Erro de rede. Tente novamente.';
            err.classList.add('visible');
          }
        } finally {
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Guardar alterações';
          }
        }
      });
    }
  }
  function init() {
    $all('.nav-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        const view = btn.getAttribute('data-view');
        if (view && titles[view]) navigate(view);
      });
    });
    const menuBtn = $('#btn-menu') || $('#mobile-toggle');
    const overlay = $('#sidebar-overlay');
    if (menuBtn) {
      menuBtn.addEventListener('click', () => {
        const sidebar = $('#sidebar');
        if (sidebar) sidebar.classList.toggle('open');
        if (overlay) { overlay.classList.toggle('open'); overlay.setAttribute('aria-hidden', overlay.classList.contains('open') ? 'false' : 'true'); }
      });
    }
    if (overlay) {
      overlay.addEventListener('click', () => {
        const sidebar = $('#sidebar');
        if (sidebar) sidebar.classList.remove('open');
        overlay.classList.remove('open');
        overlay.setAttribute('aria-hidden', 'true');
      });
    }
    initModalities();
    const form = $('#search-form');
    if (form) form.addEventListener('submit', submitSearch);
    const filterInput = $('#results-filter');
    if (filterInput) {
      filterInput.addEventListener('input', () => {
        const q = filterInput.value.trim().toLowerCase();
        $all('#results-body tr').forEach((tr) => { tr.style.display = !q || tr.textContent.toLowerCase().includes(q) ? '' : 'none'; });
      });
    }
    const selectAll = $('#select-all');
    if (selectAll) selectAll.addEventListener('change', () => { $all('.result-check').forEach((c) => { c.checked = selectAll.checked; }); });
    const saveBtn = $('#btn-save-leads');
    if (saveBtn) saveBtn.addEventListener('click', saveSelectedLeads);
    initChangePassword();
    const hash = (location.hash || '#dashboard').replace('#', '');
    navigate(titles[hash] ? hash : 'dashboard');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { init(); refreshAuthUi(); });
  else { init(); refreshAuthUi(); }
})();
