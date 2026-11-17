(function () {
  'use strict';
  const titles = {
    dashboard: 'Dashboard',
    search: 'Nova pesquisa',
    results: 'Resultados',
    history: 'Histórico',
    leads: 'Leads guardados',
    settings: 'Configurações',
    plans: 'Planos',
  };

  const PAGE_SIZE = 24;
  const HISTORY_PAGE_SIZE = 10;
  let csrfToken = null;
  let currentUser = null;
  let currentResults = [];
  let currentResultsTotal = null;
  let currentSearchMeta = null;
  let resultsPage = 1;
  let historyPage = 1;
  let historyRequestSeq = 0;
  let activeSearchId = null;
  let pollTimer = null;
  let abortRequested = false;
  let selectedLeadIds = new Set();
  let selectedHistoryIds = new Set();
  let resultsSelectAllMode = false;
  let resultsExcludedIds = new Set();


  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

  function esc(s) { return s == null ? '' : String(s); }
  function hasValue(v) {
    return v != null && String(v).trim() !== '';
  }

  function fieldRow(label, value) {
    if (!hasValue(value)) return null;
    const row = document.createElement('div');
    row.className = 'result-card-field';
    const lab = document.createElement('span');
    lab.className = 'result-card-field-label';
    lab.textContent = label;
    const val = document.createElement('span');
    val.className = 'result-card-field-value';
    val.textContent = esc(String(value).trim());
    row.appendChild(lab);
    row.appendChild(val);
    return row;
  }

  function appendField(parent, label, value) {
    const row = fieldRow(label, value);
    if (row) parent.appendChild(row);
  }

  let toastTimer = null;
  function showToast(message, type) {
    let el = $('#app-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'app-toast';
      el.className = 'app-toast';
      el.setAttribute('role', type === 'error' ? 'alert' : 'status');
      document.body.appendChild(el);
    }
    el.textContent = message || '';
    el.className = 'app-toast app-toast-' + (type || 'info');
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
  }


  let confirmResolver = null;
  function openConfirmModal(message, opts) {
    const modal = $('#confirm-modal');
    const msgEl = $('#confirm-modal-message');
    const okBtn = $('#confirm-modal-ok');
    const titleEl = $('#confirm-modal-title');
    if (!modal || !msgEl || !okBtn) {
      return Promise.resolve(window.confirm(message));
    }
    if (titleEl) titleEl.textContent = (opts && opts.title) || 'Confirmar eliminação';
    msgEl.textContent = message || '';
    okBtn.disabled = false;
    okBtn.textContent = (opts && opts.okLabel) || 'Eliminar';
    modal.hidden = false;
    return new Promise((resolve) => {
      confirmResolver = resolve;
    });
  }
  function closeConfirmModal(result) {
    const modal = $('#confirm-modal');
    if (modal) modal.hidden = true;
    const r = confirmResolver;
    confirmResolver = null;
    if (r) r(!!result);
  }
  function initConfirmModal() {
    const ok = $('#confirm-modal-ok');
    if (ok) {
      ok.addEventListener('click', () => {
        ok.disabled = true;
        closeConfirmModal(true);
      });
    }
    $$('[data-confirm-cancel]').forEach((el) => {
      el.addEventListener('click', () => closeConfirmModal(false));
    });
  }

  function isGooglePlaceId(id) {
    if (!id || typeof id !== 'string') return false;
    return /^ChIJ[A-Za-z0-9_-]{10,}$/.test(id.trim());
  }

  function buildGoogleMapsUrl(r) {
    if (!r || typeof r !== 'object') return null;
    const name = r.name && String(r.name).trim() ? String(r.name).trim() : '';
    const address = r.address && String(r.address).trim() ? String(r.address).trim() : '';
    const placeId = isGooglePlaceId(r.googlePlaceId) ? r.googlePlaceId.trim()
      : (isGooglePlaceId(r.placeId) ? r.placeId.trim() : null);
    if (placeId) {
      const q = name || address || 'place';
      return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q) +
        '&query_place_id=' + encodeURIComponent(placeId);
    }
    if (name && address) {
      return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(name + ', ' + address);
    }
    if (name) {
      return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(name);
    }
    const lat = r.lat != null ? Number(r.lat) : NaN;
    const lng = r.lng != null ? Number(r.lng) : NaN;
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(lat + ',' + lng);
    }
    return null;
  }

  function maskEmail(email) {
    const value = String(email == null ? '' : email).trim();
    const at = value.indexOf('@');
    if (at <= 0 || at === value.length - 1) return '—';
    const local = value.slice(0, at);
    const domain = value.slice(at + 1);
    if (!domain) return '—';
    return local.slice(0, Math.min(2, local.length)) + '****@' + domain;
  }

  async function ensureCsrf() {
    if (csrfToken) return csrfToken;
    const res = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
    if (!res.ok) throw new Error('CSRF');
    const data = await res.json();
    csrfToken = data.csrfToken;
    return csrfToken;
  }

  async function api(path, opts) {
    const options = opts || {};
    const headers = Object.assign({ Accept: 'application/json' }, options.headers || {});
    let body = options.body;
    if (body && typeof body === 'object' && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const res = await fetch(path, { method: options.method || 'GET', headers, body, credentials: 'same-origin' });
    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
    return { status: res.status, ok: res.ok, data };
  }

  function stopPolling() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  }

  function closeMobileSidebar() {
    const sidebar = $('#sidebar');
    const overlay = $('#sidebar-overlay');
    if (sidebar) sidebar.classList.remove('open');
    if (overlay) {
      overlay.classList.remove('open');
      overlay.setAttribute('aria-hidden', 'true');
    }
  }

  function openMobileSidebar() {
    const sidebar = $('#sidebar');
    const overlay = $('#sidebar-overlay');
    if (sidebar) sidebar.classList.add('open');
    if (overlay) {
      overlay.classList.add('open');
      overlay.setAttribute('aria-hidden', 'false');
    }
  }

  function showView(view) {
    $$('.view').forEach((el) => el.classList.toggle('active', el.id === 'view-' + view));
    $$('.nav-item').forEach((el) => {
      const dv = el.getAttribute('data-view');
      if (dv) el.classList.toggle('active', dv === view);
    });
    const t = $('#topbar-title');
    if (t) t.textContent = titles[view] || 'Maps Leads Finder';
    closeMobileSidebar();
    if (view === 'results') renderResultsState();
    if (view === 'dashboard') loadDashboard();
    if (view === 'history') {
      historyPage = 1;
      loadHistory();
    }
    if (view === 'leads') loadLeads();
    if (view === 'settings') loadSettings();
  }

  function scrollActiveViewToTop() {
    const main = document.querySelector('.main');
    const active = document.querySelector('.view.active');
    if (!active) return;
    const target = active.querySelector('.page-heading') || active;
    const mainOverflow = main ? window.getComputedStyle(main).overflowY : '';
    if (main && (mainOverflow === 'auto' || mainOverflow === 'scroll')) {
      const mainTop = main.getBoundingClientRect().top;
      const targetTop = target.getBoundingClientRect().top;
      const next = main.scrollTop + (targetTop - mainTop) - 4;
      main.scrollTo({ top: Math.max(0, next), behavior: 'smooth' });
    } else {
      try {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (_) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }
  }

  function setGuestUi() {
    const guest = $('#guest-actions');
    const user = $('#user-actions');
    const logoutBtn = $('#btn-logout');
    if (guest) guest.hidden = false;
    if (user) user.hidden = true;
    if (logoutBtn) logoutBtn.hidden = true;
  }
  function setAuthedUi() {
    const guest = $('#guest-actions');
    const user = $('#user-actions');
    const logoutBtn = $('#btn-logout');
    if (guest) guest.hidden = true;
    if (user) user.hidden = false;
    if (logoutBtn) logoutBtn.hidden = false;
  }

  async function refreshAuthUi() {
    try {
      const res = await api('/api/auth/me');
      if (res.ok && res.data && res.data.user) {
        currentUser = res.data.user;
        setAuthedUi();
        const badge = $('#auth-badge');
        if (badge) {
          badge.textContent = currentUser.emailVerified ? currentUser.name : currentUser.name + ' (email por verificar)';
          badge.title = currentUser.email || '';
        }
      } else { currentUser = null; setGuestUi(); }
    } catch (_) { currentUser = null; setGuestUi(); }
  }

  function totalPages() { return Math.max(1, Math.ceil(currentResults.length / PAGE_SIZE)); }

  function renderPagination() {
    const el = $('#results-pagination');
    if (!el) return;
    el.innerHTML = '';
    if (!currentResults.length || currentResults.length <= PAGE_SIZE) { el.hidden = true; return; }
    el.hidden = false;
    const pages = totalPages();
    const info = document.createElement('span');
    info.textContent = 'Página ' + resultsPage + ' / ' + pages;
    el.appendChild(info);
    const prev = document.createElement('button');
    prev.type = 'button'; prev.className = 'btn btn-ghost btn-sm'; prev.textContent = 'Anterior';
    prev.disabled = resultsPage <= 1;
    prev.addEventListener('click', () => {
      if (resultsPage > 1) {
        resultsPage -= 1;
        renderResultsState();
        scrollActiveViewToTop();
      }
    });
    const next = document.createElement('button');
    next.type = 'button'; next.className = 'btn btn-ghost btn-sm'; next.textContent = 'Seguinte';
    next.disabled = resultsPage >= pages;
    next.addEventListener('click', () => {
      if (resultsPage < pages) {
        resultsPage += 1;
        renderResultsState();
        scrollActiveViewToTop();
      }
    });
    el.appendChild(prev); el.appendChild(next);
  }

  function renderResultsState() {
    const grid = $('#results-cards');
    const empty = $('#results-empty');
    const count = $('#results-count');
    if (!grid) return;
    grid.innerHTML = '';
    const totalOfficial = currentResultsTotal != null ? currentResultsTotal : currentResults.length;
    if (!currentResults.length) {
      if (empty) {
        empty.hidden = false;
        const msg = (currentSearchMeta && currentSearchMeta.message) || 'Sem resultados para mostrar.';
        const h = empty.querySelector('h3'); const p = empty.querySelector('p');
        if (h) h.textContent = 'Sem resultados';
        if (p) p.textContent = msg;
      }
      if (count) count.textContent = '0 resultados';
      updateSelectedCountLabel();
      renderPagination();
      return;
    }
    if (empty) empty.hidden = true;
    if (count) {
      count.textContent = totalOfficial + ' resultado' + (totalOfficial === 1 ? '' : 's');
    }
    const pages = totalPages();
    if (resultsPage > pages) resultsPage = pages;
    if (resultsPage < 1) resultsPage = 1;
    const start = (resultsPage - 1) * PAGE_SIZE;
    const pageItems = currentResults.slice(start, start + PAGE_SIZE);
    const frag = document.createDocumentFragment();
    pageItems.forEach((r) => {
      const card = document.createElement('article');
      card.className = 'result-card';
      const body = document.createElement('div');
      body.className = 'result-card-body';
      const name = document.createElement('div');
      name.className = 'result-card-name';
      const displayName = r.name && String(r.name).trim() ? String(r.name).trim() : 'Estabelecimento';
      name.textContent = esc(displayName);
      body.appendChild(name);
      appendField(body, 'Categoria', r.category);
      appendField(body, 'Endereço', r.address);
      appendField(body, 'Telefone', r.phone);
      appendField(body, 'Email', r.email);
      appendField(body, 'Website', r.website);
      if (r.rating != null || r.reviewsCount != null) {
        const ratingBits = [];
        if (r.rating != null) ratingBits.push(String(r.rating));
        if (r.reviewsCount != null) ratingBits.push(String(r.reviewsCount) + ' avaliações');
        appendField(body, 'Classificação', ratingBits.join(' · '));
      }
      card.appendChild(body);
      const actions = document.createElement('div');
      actions.className = 'result-card-actions';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.className = 'result-check'; cb.value = r.id || '';
      cb.setAttribute('aria-label', 'Selecionar ' + displayName);
      const rid = String(r.id || '');
      if (resultsSelectAllMode) {
        cb.checked = !resultsExcludedIds.has(rid);
      }
      cb.addEventListener('change', () => {
        const id = String(cb.value || '').trim();
        if (resultsSelectAllMode) {
          if (!cb.checked) {
            if (id) resultsExcludedIds.add(id);
          } else if (id) {
            resultsExcludedIds.delete(id);
          }
        }
        updateSelectedCountLabel();
      });
      actions.appendChild(cb);
      const contactBtn = document.createElement('button');
      contactBtn.type = 'button'; contactBtn.className = 'btn btn-primary btn-sm';
      contactBtn.textContent = 'Contactar';
      if (!r.phone) { contactBtn.disabled = true; contactBtn.title = 'Sem telefone'; }
      else contactBtn.addEventListener('click', () => openContactModal(r));
      actions.appendChild(contactBtn);
      const mapsUrl = buildGoogleMapsUrl(r);
      if (mapsUrl) {
        const maps = document.createElement('a');
        maps.className = 'btn btn-secondary btn-sm';
        maps.href = mapsUrl; maps.target = '_blank'; maps.rel = 'noopener noreferrer';
        maps.textContent = 'Ver no Maps';
        actions.appendChild(maps);
      } else {
        const mapsDisabled = document.createElement('button');
        mapsDisabled.type = 'button';
        mapsDisabled.className = 'btn btn-secondary btn-sm';
        mapsDisabled.disabled = true;
        mapsDisabled.title = 'Dados insuficientes para localizar no Maps';
        mapsDisabled.textContent = 'Ver no Maps';
        actions.appendChild(mapsDisabled);
      }
      card.appendChild(actions);
      frag.appendChild(card);
    });
    grid.appendChild(frag);
    renderPagination();
    updateSelectedCountLabel();
  }

  function resetSearchUiButtons() {
    const btn = $('#btn-search');
    if (btn) { btn.disabled = false; btn.textContent = 'Pesquisar'; }
    const cancelBtn = $('#btn-cancel-search');
    if (cancelBtn) cancelBtn.hidden = true;
  }

  async function sendCancel(searchId) {
    try {
      const token = await ensureCsrf();
      await api('/api/searches/' + searchId + '/cancel', { method: 'POST', headers: { 'X-CSRF-Token': token }, body: {} });
    } catch (_) {}
  }

  function openContactModal(r) {
    const modal = $('#contact-modal');
    if (!modal) return;
    modal.hidden = false;
    const title = $('#contact-modal-title');
    if (title) title.textContent = r.name || 'Contacto';
    const place = $('#contact-modal-place');
    if (place) place.textContent = (r.name || '') + (r.phone ? ' · ' + r.phone : '');
    const msg = $('#contact-message');
    if (msg) msg.value = 'Olá, vi o estabelecimento ' + (r.name || '') + ' e gostaria de mais informações.';
    modal.dataset.phone = r.phone || '';
    modal.dataset.name = r.name || '';
  }

  function closeContactModal() {
    const modal = $('#contact-modal');
    if (modal) modal.hidden = true;
  }

  function setProgress(visible, text) {
    const box = $('#results-progress');
    if (!box) return;
    box.hidden = !visible;
    if (text) {
      const p = box.querySelector('p') || $('#results-progress-text');
      if (p) p.textContent = text;
    }
  }

  function setSearchProgress(visible) {
    const box = $('#search-progress');
    if (!box) return;
    box.hidden = !visible;
  }

  function officialResultsTotal(payload) {
    const d = payload || {};
    if (d.search && d.search.resultsCount != null) return Number(d.search.resultsCount);
    if (d.totals && d.totals.afterFilters != null) return Number(d.totals.afterFilters);
    if (Array.isArray(d.results)) return d.results.length;
    return 0;
  }

  function getSelectedResultIds() {
    if (resultsSelectAllMode && currentResults.length) {
      return currentResults
        .map((r) => (r && r.id != null ? String(r.id) : ''))
        .filter((id) => id && !resultsExcludedIds.has(id));
    }
    const seen = new Set();
    const ids = [];
    $$('.result-check:checked').forEach((el) => {
      const id = el && el.value ? String(el.value).trim() : '';
      if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
    });
    return ids;
  }

  function updateSelectedCountLabel() {
    const btn = $('#btn-save-leads');
    const master = $('#results-select-all');
    const pageChecks = $$('.result-check');
    const checkedPage = pageChecks.filter((c) => c.checked).length;
    let n;
    if (resultsSelectAllMode) {
      n = Math.max(0, currentResults.length - resultsExcludedIds.size);
    } else {
      n = checkedPage;
    }
    if (btn && btn.dataset.busy !== '1') {
      btn.textContent = n > 0 ? ('Guardar seleccionados (' + n + ')') : 'Guardar seleccionados';
    }
    if (master) {
      if (resultsSelectAllMode) {
        if (resultsExcludedIds.size === 0 && currentResults.length > 0) {
          master.checked = true;
          master.indeterminate = false;
        } else if (n === 0) {
          master.checked = false;
          master.indeterminate = false;
        } else {
          master.checked = false;
          master.indeterminate = true;
        }
      } else if (!pageChecks.length) {
        master.checked = false;
        master.indeterminate = false;
      } else if (checkedPage === pageChecks.length) {
        master.checked = true;
        master.indeterminate = false;
      } else if (checkedPage === 0) {
        master.checked = false;
        master.indeterminate = false;
      } else {
        master.checked = false;
        master.indeterminate = true;
      }
    }
  }

  function setResultsSelectAll(on) {
    resultsSelectAllMode = !!on;
    resultsExcludedIds.clear();
    $$('.result-check').forEach((c) => { c.checked = !!on; });
    updateSelectedCountLabel();
  }

  function clearResultsSelection() {
    resultsSelectAllMode = false;
    resultsExcludedIds.clear();
    $$('.result-check').forEach((c) => { c.checked = false; });
    updateSelectedCountLabel();
  }

  async function saveSelectedLeads() {
    const btn = $('#btn-save-leads');
    const ids = getSelectedResultIds();
    if (!ids.length) {
      showToast('Seleciona pelo menos um resultado.', 'error');
      return;
    }
    if (btn) {
      btn.disabled = true;
      btn.dataset.busy = '1';
      btn.textContent = 'A guardar…';
    }
    try {
      const token = await ensureCsrf();
      const res = await api('/api/searches/leads/save', {
        method: 'POST',
        headers: { 'X-CSRF-Token': token },
        body: { resultIds: ids },
      });
      const data = res.data || {};
      if (res.ok) {
        const saved = data.savedCount != null ? Number(data.savedCount) : 0;
        const already = data.alreadySavedCount != null ? Number(data.alreadySavedCount) : 0;
        let msg;
        if (saved > 0 && already > 0) {
          msg = saved + ' lead' + (saved === 1 ? '' : 's') + ' guardado' + (saved === 1 ? '' : 's') +
            '. ' + already + ' já ' + (already === 1 ? 'estava' : 'estavam') + ' guardado' + (already === 1 ? '' : 's') + '.';
        } else if (saved > 0) {
          msg = saved + ' lead' + (saved === 1 ? '' : 's') + ' guardado' + (saved === 1 ? '' : 's') + ' com sucesso.';
        } else if (already > 0) {
          msg = already === 1
            ? 'Este lead já estava guardado.'
            : 'Os ' + already + ' leads seleccionados já estavam guardados.';
        } else {
          msg = 'Nenhum lead foi guardado.';
        }
        showToast(msg, saved > 0 ? 'success' : 'info');
        // Clear selection of processed results
        clearResultsSelection();
        if (typeof loadDashboard === 'function') {
          try { loadDashboard(); } catch (_) {}
        }
      } else if (res.status === 400) {
        showToast((data && data.error) || 'Pedido inválido. Seleciona pelo menos um resultado.', 'error');
      } else if (res.status === 401) {
        showToast((data && data.error) || 'Sessão inválida. Inicia sessão novamente.', 'error');
      } else if (res.status === 403) {
        const err = (data && data.error) || '';
        if (/csrf|token/i.test(err)) {
          showToast(err || 'Pedido rejeitado (CSRF). Recarrega a página e tenta de novo.', 'error');
        } else if (/email|verif/i.test(err)) {
          showToast(err || 'Verifica o email da conta para guardar leads.', 'error');
        } else {
          showToast(err || 'Não tens permissão para guardar leads.', 'error');
        }
      } else if (res.status >= 500) {
        showToast((data && data.error) || 'Erro interno ao guardar leads. Tenta novamente.', 'error');
      } else {
        showToast((data && data.error) || 'Não foi possível guardar os leads.', 'error');
      }
    } catch (_) {
      showToast('Erro de rede ao guardar leads.', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        delete btn.dataset.busy;
      }
      updateSelectedCountLabel();
    }
  }


  async function saveAllLeads() {
    if (!currentResults.length) {
      showToast('Não há resultados para guardar.', 'error');
      return;
    }
    const ok = await openConfirmModal(
      'Vais guardar todos os ' + currentResults.length + ' resultados desta pesquisa. Continuar?',
      { title: 'Guardar todos', okLabel: 'Guardar todos' }
    );
    if (!ok) return;
    setResultsSelectAll(true);
    await saveSelectedLeads();
  }

  function setSummary(visible, text) {
    const box = $('#results-summary');
    const t = $('#results-summary-text');
    if (box) box.hidden = !visible;
    if (t && text != null) t.textContent = text;
  }

  function setStatus(msg, isError) {
    const el = $('#search-status');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('error', !!isError);
  }

  function formatDate(v) {
    if (!v) return '—';
    try { return new Date(v).toLocaleString(); } catch (_) { return String(v); }
  }

  async function pollSearchUntilDone(searchId) {
    while (!abortRequested) {
      let statusRes;
      try {
        statusRes = await api('/api/searches/' + searchId + '/status');
      } catch (_) {
        setSearchProgress(false);
        setProgress(false);
        setStatus('Não foi possível consultar o estado da pesquisa. Tenta novamente.', true);
        stopPolling(); resetSearchUiButtons(); activeSearchId = null;
        return { outcome: 'error' };
      }
      if (!statusRes.ok) {
        const msg = (statusRes.data && statusRes.data.error) ||
          (statusRes.status === 404 ? 'Pesquisa não encontrada.' : 'Não foi possível obter o estado da pesquisa.');
        setSearchProgress(false);
        setProgress(false);
        setStatus(msg, true);
        currentResults = []; currentResultsTotal = 0; currentSearchMeta = { message: msg };
        stopPolling(); resetSearchUiButtons(); activeSearchId = null;
        return { outcome: 'error' };
      }
      const data = statusRes.data || {};
      const status = data.status || '';
      setSearchProgress(true);
      if (status === 'running' || status === 'pending' || status === 'queued') {
        await new Promise((r) => { pollTimer = setTimeout(r, 1500); });
        continue;
      }
      stopPolling();
      if (status === 'cancelled') {
        setSearchProgress(false);
        setProgress(false);
        currentResults = [];
        currentResultsTotal = 0;
        currentSearchMeta = { searchId, status: 'cancelled', message: 'Pesquisa cancelada.' };
        setStatus('Pesquisa cancelada.');
        resetSearchUiButtons(); activeSearchId = null;
        return { outcome: 'cancelled' };
      }
      if (status === 'failed' || status === 'error') {
        const errMsg = data.errorSummary || data.message || 'A pesquisa falhou.';
        setSearchProgress(false);
        setProgress(false);
        currentResults = [];
        currentResultsTotal = 0;
        currentSearchMeta = { searchId, status, message: errMsg };
        setStatus(errMsg, true);
        resetSearchUiButtons(); activeSearchId = null;
        return { outcome: 'error' };
      }
      setSearchProgress(true);
      let resultsRes;
      try {
        resultsRes = await api('/api/searches/' + searchId + '/results');
      } catch (_) {
        setSearchProgress(false);
        setProgress(false);
        setStatus('Não foi possível carregar os resultados. Tenta novamente.', true);
        currentResults = [];
        currentResultsTotal = 0;
        currentSearchMeta = { message: 'Não foi possível carregar os resultados.' };
        resetSearchUiButtons(); activeSearchId = null;
        return { outcome: 'error' };
      }
      if (!resultsRes.ok) {
        const msg = (resultsRes.data && resultsRes.data.error) || 'Não foi possível carregar os resultados.';
        setSearchProgress(false);
        setProgress(false);
        setStatus(msg, true);
        currentResults = [];
        currentResultsTotal = 0;
        currentSearchMeta = { message: msg };
        resetSearchUiButtons(); activeSearchId = null;
        return { outcome: 'error' };
      }
      if (abortRequested) {
        setSearchProgress(false);
        setProgress(false);
        currentResults = [];
        currentResultsTotal = 0;
        currentSearchMeta = { searchId, status: 'cancelled', message: 'Pesquisa cancelada.' };
        setStatus('Pesquisa cancelada.');
        resetSearchUiButtons(); activeSearchId = null;
        return { outcome: 'cancelled' };
      }
      const d2 = resultsRes.data || {};
      clearResultsSelection();
      currentResults = Array.isArray(d2.results) ? d2.results : [];
      currentResultsTotal = officialResultsTotal(d2);
      resultsPage = 1;
      currentSearchMeta = { searchId, status: (d2.search && d2.search.status) || status, message: d2.message || '' };
      setSearchProgress(false);
      setProgress(false);
      setStatus('');
      renderResultsState();
      showView('results');
      resetSearchUiButtons();
      activeSearchId = null;
      return { outcome: 'success' };
    }
    stopPolling();
    setSearchProgress(false);
    setProgress(false);
    resetSearchUiButtons();
    activeSearchId = null;
    return { outcome: 'cancelled' };
  }

  async function runSearch() {
    clearResultsSelection();
    const query = (($('#query') && $('#query').value) || '').trim();
    const location = (($('#location') && $('#location').value) || '').trim();
    const limitEl = $('#limit');
    const limit = limitEl ? parseInt(limitEl.value, 10) : 100;
    const minRatingEl = $('#min-rating');
    const minRating = minRatingEl ? minRatingEl.value : '';
    const hasPhone = !!document.querySelector('input[name="hasPhone"]:checked');
    const hasEmail = !!document.querySelector('input[name="hasEmail"]:checked');
    const noWebsite = !!document.querySelector('input[name="noWebsite"]:checked');
    const minReviews = !!document.querySelector('input[name="minReviews"]:checked');
    if (!query || !location) { setStatus('Preenche categoria e localização.', true); return; }
    stopPolling();
    abortRequested = false;
    currentResults = [];
    currentResultsTotal = null;
    resultsPage = 1;
    currentSearchMeta = null;
    setSummary(false, '');
    setProgress(false);
    const btn = $('#btn-search');
    if (btn) { btn.disabled = true; btn.textContent = 'A pesquisar…'; }
    let cancelBtn = $('#btn-cancel-search');
    if (!cancelBtn && btn && btn.parentElement) {
      cancelBtn = document.createElement('button');
      cancelBtn.type = 'button'; cancelBtn.id = 'btn-cancel-search';
      cancelBtn.className = 'btn btn-ghost'; cancelBtn.textContent = 'Cancelar';
      btn.parentElement.appendChild(cancelBtn);
    }
    if (cancelBtn) {
      cancelBtn.hidden = false;
      cancelBtn.onclick = async () => {
        abortRequested = true;
        stopPolling();
        if (activeSearchId) await sendCancel(activeSearchId);
        setSearchProgress(false);
        setProgress(false);
        setStatus('Pesquisa cancelada.');
        currentResults = [];
        currentResultsTotal = 0;
        currentSearchMeta = { message: 'Pesquisa cancelada.' };
        resetSearchUiButtons();
        activeSearchId = null;
      };
    }
    setSearchProgress(true);
    setStatus('');
    try {
      const token = await ensureCsrf();
      if (abortRequested) {
        setSearchProgress(false);
        setStatus('Pesquisa cancelada.');
        resetSearchUiButtons();
        return;
      }
      const res = await api('/api/searches', {
        method: 'POST',
        headers: { 'X-CSRF-Token': token },
        body: {
          query, location, limit,
          filters: {
            minRating: minRating || undefined,
            hasPhone: hasPhone || undefined,
            hasEmail: hasEmail || undefined,
            noWebsite: noWebsite || undefined,
            minReviews: minReviews || undefined,
          },
        },
      });
      if (abortRequested) {
        const sid = res && res.data && (res.data.searchId || res.data.id);
        if (sid) {
          activeSearchId = sid;
          await sendCancel(sid);
        }
        setSearchProgress(false);
        setStatus('Pesquisa cancelada.');
        currentResults = [];
        currentResultsTotal = 0;
        resetSearchUiButtons();
        activeSearchId = null;
        return;
      }
      if (!res.ok) {
        const err = (res.data && res.data.error) || 'Não foi possível iniciar a pesquisa.';
        setStatus(err, true);
        setSearchProgress(false);
        setProgress(false);
        resetSearchUiButtons();
        activeSearchId = null;
        return;
      }
      const searchId = res.data && (res.data.searchId || res.data.id);
      if (!searchId) {
        setStatus('Resposta inválida do servidor.', true);
        setSearchProgress(false);
        resetSearchUiButtons();
        return;
      }
      activeSearchId = searchId;
      if (abortRequested) {
        await sendCancel(searchId);
        setSearchProgress(false);
        setStatus('Pesquisa cancelada.');
        resetSearchUiButtons();
        activeSearchId = null;
        return;
      }
      await pollSearchUntilDone(searchId);
    } catch (_) {
      setStatus('Erro de rede ao iniciar a pesquisa.', true);
      setSearchProgress(false);
      setProgress(false);
      resetSearchUiButtons();
      activeSearchId = null;
    }
  }

  async function openSearch(id) {
    if (!id) return;
    showView('results');
    setProgress(true, 'A carregar pesquisa…');
    setStatus('');
    try {
      const resultsRes = await api('/api/searches/' + id + '/results');
      setProgress(false);
      if (!resultsRes.ok) {
        const msg = (resultsRes.data && resultsRes.data.error) || 'Não foi possível carregar os resultados.';
        setStatus(msg, true); setSummary(true, msg);
        currentResults = []; currentResultsTotal = 0; currentSearchMeta = { message: msg };
        renderResultsState();
        return;
      }
      const d2 = resultsRes.data || {};
      clearResultsSelection();
      currentResults = Array.isArray(d2.results) ? d2.results : [];
      currentResultsTotal = officialResultsTotal(d2);
      resultsPage = 1;
      currentSearchMeta = { searchId: id, status: (d2.search && d2.search.status) || '', message: d2.message || '' };
      const msg = currentResultsTotal
        ? currentResultsTotal + ' resultado(s) encontrados.'
        : (d2.message || 'Nenhum resultado encontrado.');
      setStatus('');
      setSummary(true, msg);
      renderResultsState();
    } catch (_) {
      setProgress(false);
      setStatus('Erro de rede.', true);
      setSummary(true, 'Erro de rede.');
    }
  }

  function ensureHistoryPaginationEl() {
    let el = $('#history-pagination');
    if (el) return el;
    const body = $('#history-body');
    if (!body) return null;
    const card = body.closest('.card') || body.parentElement;
    if (!card) return null;
    el = document.createElement('div');
    el.id = 'history-pagination';
    el.className = 'results-pagination';
    el.hidden = true;
    card.appendChild(el);
    return el;
  }

  function renderHistoryPagination(hasNext) {
    const el = ensureHistoryPaginationEl();
    if (!el) return;
    el.innerHTML = '';
    if (historyPage <= 1 && !hasNext) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const info = document.createElement('span');
    info.textContent = 'Página ' + historyPage;
    el.appendChild(info);
    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'btn btn-ghost btn-sm';
    prev.textContent = 'Anterior';
    prev.disabled = historyPage <= 1;
    prev.addEventListener('click', () => {
      if (historyPage <= 1) return;
      historyPage -= 1;
      loadHistory({ scrollToTop: true });
    });
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'btn btn-ghost btn-sm';
    next.textContent = 'Seguinte';
    next.disabled = !hasNext;
    next.addEventListener('click', () => {
      if (!hasNext) return;
      historyPage += 1;
      loadHistory({ scrollToTop: true });
    });
    el.appendChild(prev);
    el.appendChild(next);
  }

  async function loadHistory(opts) {
    const options = opts || {};
    const body = $('#history-body');
    if (!body) return;
    const requestId = ++historyRequestSeq;
    const page = historyPage < 1 ? 1 : historyPage;
    historyPage = page;
    const offset = (page - 1) * HISTORY_PAGE_SIZE;
    body.innerHTML = '';
    try {
      const res = await api('/api/searches?limit=' + (HISTORY_PAGE_SIZE + 1) + '&offset=' + offset);
      if (requestId !== historyRequestSeq) return;
      if (!res.ok) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 7;
        td.textContent = res.status === 401 ? 'Inicia sessão para ver o histórico.' : 'Não foi possível carregar o histórico.';
        tr.appendChild(td);
        body.appendChild(tr);
        renderHistoryPagination(false);
        return;
      }
      const rawItems = (res.data && res.data.items) || [];
      const hasNext = rawItems.length > HISTORY_PAGE_SIZE;
      const items = hasNext ? rawItems.slice(0, HISTORY_PAGE_SIZE) : rawItems;
      if (!items.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 7;
        td.textContent = page === 1 ? 'Ainda não há pesquisas.' : 'Não há mais pesquisas nesta página.';
        tr.appendChild(td);
        body.appendChild(tr);
        renderHistoryPagination(false);
        if (options.scrollToTop) scrollActiveViewToTop();
        return;
      }
      items.forEach((item) => {
        const tr = document.createElement('tr');
        const tdCheck = document.createElement('td');
        tdCheck.className = 'col-check';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'history-check';
        cb.value = item.id || '';
        cb.checked = selectedHistoryIds.has(String(item.id));
        cb.addEventListener('click', (e) => e.stopPropagation());
        cb.addEventListener('change', () => {
          const id = String(item.id);
          if (cb.checked) selectedHistoryIds.add(id);
          else selectedHistoryIds.delete(id);
          updateHistorySelectionUi();
        });
        tdCheck.appendChild(cb);
        tr.appendChild(tdCheck);
        tr.style.cursor = 'pointer';
        tr.addEventListener('click', () => openSearch(item.id));
        [item.query, item.location, item.resultsCount != null ? item.resultsCount : '—', item.status, formatDate(item.createdAt)].forEach((val, idx) => {
          const td = document.createElement('td');
          if (idx === 3) {
            const pill = document.createElement('span');
            pill.className = 'status-pill ' + esc(item.status);
            pill.textContent = esc(item.status);
            td.appendChild(pill);
          } else {
            td.textContent = val == null ? '—' : String(val);
          }
          tr.appendChild(td);
        });
        const tdAct = document.createElement('td');
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'btn btn-danger btn-sm';
        delBtn.textContent = 'Eliminar';
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteOneSearch(item.id, item.query || item.location || item.id);
        });
        tdAct.appendChild(delBtn);
        tr.appendChild(tdAct);
        body.appendChild(tr);
      });
      updateHistorySelectionUi();
      renderHistoryPagination(hasNext);
      if (options.scrollToTop) scrollActiveViewToTop();
    } catch (_) {
      if (requestId !== historyRequestSeq) return;
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.textContent = 'Não foi possível carregar o histórico.';
      tr.appendChild(td);
      body.appendChild(tr);
      renderHistoryPagination(false);
    }
  }

  const LEADS_PAGE_SIZE = 20;
  const CRM_STATUS_CLASS = {
    'Por contactar': 'is-pending',
    'Contactado': 'is-contacted',
    'Não atendeu': 'is-contacted',
    'Aguardando resposta': 'is-waiting',
    'Interessado': 'is-interested',
    'Reunião agendada': 'is-meeting',
    'Não interessado': 'is-rejected',
    'Cliente': 'is-client',
  };

  let leadsPage = 1;
  let leadsTotal = 0;
  let leadsRequestSeq = 0;
  let leadsFiltersBound = false;
  let currentLeadId = null;
  let leadsReturnState = null;

  function leadsQueryParams() {
    const q = (($('#leads-q') && $('#leads-q').value) || '').trim();
    const status = (($('#leads-status') && $('#leads-status').value) || '').trim();
    const category = (($('#leads-category') && $('#leads-category').value) || '').trim();
    const sort = (($('#leads-sort') && $('#leads-sort').value) || 'recent').trim();
    const offset = (Math.max(1, leadsPage) - 1) * LEADS_PAGE_SIZE;
    const params = new URLSearchParams();
    params.set('limit', String(LEADS_PAGE_SIZE));
    params.set('offset', String(offset));
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    if (category) params.set('category', category);
    if (sort) params.set('sort', sort);
    return params;
  }

  function updateLeadsStats(statusCounts, totalLeads) {
    const sc = statusCounts || {};
    const set = (id, val) => { const el = $('#' + id); if (el) el.textContent = String(val); };
    set('leads-stat-total', totalLeads != null ? totalLeads : '—');
    set('leads-stat-pending', sc['Por contactar'] != null ? sc['Por contactar'] : '—');
    set('leads-stat-interested', sc['Interessado'] != null ? sc['Interessado'] : '—');
    set('leads-stat-clients', sc['Cliente'] != null ? sc['Cliente'] : '—');
  }

  function fillLeadsCategories(categories, selected) {
    const sel = $('#leads-category');
    if (!sel) return;
    const current = selected != null ? selected : sel.value;
    sel.innerHTML = '';
    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'Todas as categorias';
    sel.appendChild(all);
    (categories || []).forEach((c) => {
      if (!c) return;
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      sel.appendChild(opt);
    });
    if (current && Array.from(sel.options).some((o) => o.value === current)) {
      sel.value = current;
    }
  }

  function statusBadge(status) {
    const span = document.createElement('span');
    const st = status || 'Por contactar';
    span.className = 'leads-crm-status ' + (CRM_STATUS_CLASS[st] || 'is-pending');
    span.textContent = st;
    return span;
  }

  function renderLeadsPagination() {
    const el = $('#leads-pagination');
    if (!el) return;
    el.innerHTML = '';
    const pages = Math.max(1, Math.ceil(leadsTotal / LEADS_PAGE_SIZE));
    if (leadsTotal <= LEADS_PAGE_SIZE) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const info = document.createElement('span');
    info.textContent = 'Página ' + leadsPage + ' / ' + pages + ' · ' + leadsTotal + ' resultado' + (leadsTotal === 1 ? '' : 's');
    el.appendChild(info);
    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'btn btn-ghost btn-sm';
    prev.textContent = 'Anterior';
    prev.disabled = leadsPage <= 1;
    prev.addEventListener('click', () => {
      if (leadsPage <= 1) return;
      leadsPage -= 1;
      loadLeads({ scrollToTop: true });
    });
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'btn btn-ghost btn-sm';
    next.textContent = 'Seguinte';
    next.disabled = leadsPage >= pages;
    next.addEventListener('click', () => {
      if (leadsPage >= pages) return;
      leadsPage += 1;
      loadLeads({ scrollToTop: true });
    });
    el.appendChild(prev);
    el.appendChild(next);
  }

  function showLeadsList() {
    const list = $('#leads-list-panel');
    const detail = $('#leads-detail-panel');
    hideLeadSubpanels();
    if (list) list.hidden = false;
    if (detail) detail.hidden = true;
    currentLeadId = null;
  }

  function showLeadsDetail() {
    const list = $('#leads-list-panel');
    const detail = $('#leads-detail-panel');
    if (list) list.hidden = true;
    if (detail) detail.hidden = false;
  }


  function updateLeadsSelectionUi() {
    const countEl = $('#leads-selected-count');
    const delBtn = $('#leads-delete-selected');
    const master = $('#leads-select-page');
    const n = selectedLeadIds.size;
    if (countEl) countEl.textContent = n + ' seleccionado' + (n === 1 ? '' : 's');
    if (delBtn) delBtn.disabled = n === 0;
    const pageChecks = $$('.lead-check');
    if (master && pageChecks.length) {
      const checked = pageChecks.filter((c) => c.checked).length;
      master.checked = checked === pageChecks.length;
      master.indeterminate = checked > 0 && checked < pageChecks.length;
    } else if (master) {
      master.checked = false;
      master.indeterminate = false;
    }
  }

  function updateHistorySelectionUi() {
    const countEl = $('#history-selected-count');
    const delBtn = $('#history-delete-selected');
    const master = $('#history-select-page');
    const n = selectedHistoryIds.size;
    if (countEl) countEl.textContent = n + ' seleccionada' + (n === 1 ? '' : 's');
    if (delBtn) delBtn.disabled = n === 0;
    const pageChecks = $$('.history-check');
    if (master && pageChecks.length) {
      const checked = pageChecks.filter((c) => c.checked).length;
      master.checked = checked === pageChecks.length;
      master.indeterminate = checked > 0 && checked < pageChecks.length;
    } else if (master) {
      master.checked = false;
      master.indeterminate = false;
    }
  }

  async function deleteOneLead(id, name) {
    const ok = await openConfirmModal(
      'Tens a certeza de que pretendes eliminar o lead «' + (name || id) + '»? As actividades e agendamentos associados também serão eliminados.'
    );
    if (!ok) return;
    try {
      const token = await ensureCsrf();
      const res = await api('/api/searches/leads/saved/' + encodeURIComponent(id), {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': token },
      });
      if (!res.ok) {
        showToast((res.data && res.data.error) || 'Não foi possível eliminar o lead.', 'error');
        return;
      }
      selectedLeadIds.delete(String(id));
      showToast('Lead eliminado.', 'success');
      if (currentLeadId && String(currentLeadId) === String(id)) {
        currentLeadId = null;
        const panel = $('#leads-detail-panel');
        const list = $('#leads-list-panel');
        if (panel) panel.hidden = true;
        if (list) list.hidden = false;
      }
      loadLeads({ scrollToTop: false });
      if (typeof loadDashboard === 'function') try { loadDashboard(); } catch (_) {}
    } catch (_) {
      showToast('Erro de rede ao eliminar o lead.', 'error');
    }
  }

  async function deleteSelectedLeads() {
    const ids = Array.from(selectedLeadIds);
    if (!ids.length) return;
    const ok = await openConfirmModal(
      'Serão eliminados ' + ids.length + ' lead' + (ids.length === 1 ? '' : 's') +
      ' seleccionado' + (ids.length === 1 ? '' : 's') + ' e os respectivos dados comerciais.'
    );
    if (!ok) return;
    const BATCH = 500;
    let totalDeleted = 0;
    let remaining = ids.map(String);
    let stoppedEarly = false;
    try {
      const token = await ensureCsrf();
      while (remaining.length) {
        const batch = remaining.slice(0, BATCH);
        let res;
        try {
          res = await api('/api/searches/leads/saved/delete', {
            method: 'POST',
            headers: { 'X-CSRF-Token': token },
            body: { ids: batch },
          });
        } catch (networkErr) {
          batch.forEach((id) => selectedLeadIds.add(String(id)));
          remaining.forEach((id) => selectedLeadIds.add(String(id)));
          showToast(
            (totalDeleted ? (totalDeleted + ' eliminados. ') : '') + 'Erro de rede ao eliminar leads.',
            'error'
          );
          stoppedEarly = true;
          break;
        }
        if (!res.ok) {
          batch.forEach((id) => selectedLeadIds.add(String(id)));
          remaining.forEach((id) => selectedLeadIds.add(String(id)));
          showToast(
            (totalDeleted ? (totalDeleted + ' eliminados. ') : '') +
            ((res.data && res.data.error) || 'Não foi possível eliminar todos os leads seleccionados.'),
            'error'
          );
          stoppedEarly = true;
          break;
        }
        const deletedIds = ((res.data && res.data.deletedIds) || []).map(String);
        const deletedSet = new Set(deletedIds);
        deletedSet.forEach((id) => selectedLeadIds.delete(id));
        totalDeleted += deletedSet.size;
        const notDeleted = batch.filter((id) => !deletedSet.has(String(id)));
        if (notDeleted.length) {
          notDeleted.forEach((id) => selectedLeadIds.add(String(id)));
          remaining = notDeleted.concat(remaining.slice(BATCH));
          showToast(
            (totalDeleted ? (totalDeleted + ' eliminados. ') : '') +
            notDeleted.length + ' não eliminados permanecem seleccionados.',
            'error'
          );
          stoppedEarly = true;
          break;
        }
        remaining = remaining.slice(BATCH);
      }
      if (!stoppedEarly) {
        showToast(totalDeleted + ' lead' + (totalDeleted === 1 ? '' : 's') + ' eliminado' + (totalDeleted === 1 ? '' : 's') + '.', 'success');
        if (typeof loadDashboard === 'function') try { loadDashboard(); } catch (_) {}
      }
      loadLeads({ scrollToTop: false });
    } catch (_) {
      remaining.forEach((id) => selectedLeadIds.add(String(id)));
      showToast(
        (totalDeleted ? (totalDeleted + ' eliminados. ') : '') + 'Erro de rede ao eliminar leads.',
        'error'
      );
      loadLeads({ scrollToTop: false });
    }
  }

  async function deleteAllLeads() {
    const ok = await openConfirmModal(
      'Esta operação eliminará TODOS os leads guardados da tua conta e os respectivos dados comerciais (notas, actividades e agendamentos). Esta acção não pode ser anulada.'
    );
    if (!ok) return;
    try {
      const token = await ensureCsrf();
      const res = await api('/api/searches/leads/saved/delete', {
        method: 'POST',
        headers: { 'X-CSRF-Token': token },
        body: { all: true },
      });
      if (!res.ok) {
        showToast((res.data && res.data.error) || 'Não foi possível eliminar os leads.', 'error');
        return;
      }
      const n = (res.data && res.data.deletedCount) || 0;
      selectedLeadIds.clear();
      showToast(n + ' lead' + (n === 1 ? '' : 's') + ' eliminado' + (n === 1 ? '' : 's') + '.', 'success');
      loadLeads({ scrollToTop: true });
      if (typeof loadDashboard === 'function') try { loadDashboard(); } catch (_) {}
    } catch (_) {
      showToast('Erro de rede ao eliminar leads.', 'error');
    }
  }

  async function deleteOneSearch(id, label) {
    const ok = await openConfirmModal(
      'Tens a certeza de que pretendes eliminar a pesquisa «' + (label || id) + '»? Os leads guardados a partir desta pesquisa não serão afectados.'
    );
    if (!ok) return;
    try {
      const token = await ensureCsrf();
      const res = await api('/api/searches/' + encodeURIComponent(id), {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': token },
      });
      if (res.status === 409) {
        showToast((res.data && res.data.error) || 'Pesquisa em execução. Cancela-a primeiro.', 'error');
        return;
      }
      if (!res.ok) {
        showToast((res.data && res.data.error) || 'Não foi possível eliminar a pesquisa.', 'error');
        return;
      }
      selectedHistoryIds.delete(String(id));
      showToast('Pesquisa eliminada.', 'success');
      loadHistory({ scrollToTop: false });
    } catch (_) {
      showToast('Erro de rede ao eliminar a pesquisa.', 'error');
    }
  }

    async function deleteSelectedSearches() {
    const ids = Array.from(selectedHistoryIds);
    if (!ids.length) return;
    const ok = await openConfirmModal(
      'Serão eliminadas ' + ids.length + ' pesquisa' + (ids.length === 1 ? '' : 's') +
      ' seleccionada' + (ids.length === 1 ? '' : 's') + '. Os leads guardados não serão afectados.'
    );
    if (!ok) return;
    const BATCH = 500;
    let totalDeleted = 0;
    let totalSkipped = [];
    let remaining = ids.map(String);
    let stoppedEarly = false;
    try {
      const token = await ensureCsrf();
      while (remaining.length) {
        const batch = remaining.slice(0, BATCH);
        let res;
        try {
          res = await api('/api/searches/delete', {
            method: 'POST',
            headers: { 'X-CSRF-Token': token },
            body: { ids: batch },
          });
        } catch (networkErr) {
          batch.forEach((id) => selectedHistoryIds.add(String(id)));
          remaining.forEach((id) => selectedHistoryIds.add(String(id)));
          showToast(
            (totalDeleted ? (totalDeleted + ' eliminadas. ') : '') + 'Erro de rede ao eliminar pesquisas.',
            'error'
          );
          stoppedEarly = true;
          break;
        }
        if (!res.ok && res.status !== 409) {
          batch.forEach((id) => selectedHistoryIds.add(String(id)));
          remaining.forEach((id) => selectedHistoryIds.add(String(id)));
          showToast(
            (totalDeleted ? (totalDeleted + ' eliminadas. ') : '') +
            ((res.data && res.data.error) || 'Não foi possível eliminar todas as pesquisas seleccionadas.'),
            'error'
          );
          stoppedEarly = true;
          break;
        }
        const deletedIds = ((res.data && res.data.deletedIds) || []).map(String);
        const skipped = ((res.data && res.data.skippedRunning) || []).map(String);
        const deletedSet = new Set(deletedIds);
        const skippedSet = new Set(skipped);
        deletedSet.forEach((id) => selectedHistoryIds.delete(id));
        totalDeleted += deletedSet.size;
        totalSkipped = totalSkipped.concat(skipped);
        skipped.forEach((id) => selectedHistoryIds.add(String(id)));
        const unresolved = batch.filter(
          (id) => !deletedSet.has(String(id)) && !skippedSet.has(String(id))
        );
        if (unresolved.length) {
          unresolved.forEach((id) => selectedHistoryIds.add(String(id)));
          remaining = unresolved.concat(
            batch.filter((id) => skippedSet.has(String(id)))
          ).concat(remaining.slice(BATCH));
          showToast(
            (totalDeleted ? (totalDeleted + ' eliminadas. ') : '') +
            unresolved.length + ' não eliminadas permanecem seleccionadas.',
            'error'
          );
          stoppedEarly = true;
          break;
        }
        remaining = remaining.slice(BATCH);
      }
      if (!stoppedEarly) {
        let msg = totalDeleted + ' pesquisa' + (totalDeleted === 1 ? '' : 's') + ' eliminada' + (totalDeleted === 1 ? '' : 's') + '.';
        if (totalSkipped.length) msg += ' ' + totalSkipped.length + ' em execução foram ignoradas.';
        showToast(msg, totalSkipped.length && !totalDeleted ? 'error' : 'success');
      }
      loadHistory({ scrollToTop: false });
    } catch (_) {
      remaining.forEach((id) => selectedHistoryIds.add(String(id)));
      showToast(
        (totalDeleted ? (totalDeleted + ' eliminadas. ') : '') + 'Erro de rede ao eliminar pesquisas.',
        'error'
      );
      loadHistory({ scrollToTop: false });
    }
  }


  async function deleteAllSearches() {
    const ok = await openConfirmModal(
      'Esta operação eliminará todas as pesquisas do teu histórico. Os leads guardados não serão afectados. Pesquisas em execução serão ignoradas.'
    );
    if (!ok) return;
    try {
      const token = await ensureCsrf();
      const res = await api('/api/searches/delete', {
        method: 'POST',
        headers: { 'X-CSRF-Token': token },
        body: { all: true },
      });
      if (!res.ok) {
        showToast((res.data && res.data.error) || 'Não foi possível eliminar o histórico.', 'error');
        return;
      }
      const n = (res.data && res.data.deletedCount) || 0;
      const skipped = (res.data && res.data.skippedRunning) || [];
      selectedHistoryIds.clear();
      let msg = n + ' pesquisa' + (n === 1 ? '' : 's') + ' eliminada' + (n === 1 ? '' : 's') + '.';
      if (skipped.length) msg += ' ' + skipped.length + ' em execução foram ignoradas.';
      showToast(msg, 'success');
      historyPage = 1;
      loadHistory({ scrollToTop: true });
    } catch (_) {
      showToast('Erro de rede ao eliminar o histórico.', 'error');
    }
  }

  async function deleteOneActivity(activityId, summary) {
    const ok = await openConfirmModal(
      'Eliminar esta actividade?' + (summary ? ('\n' + summary) : '')
    );
    if (!ok || !currentLeadId) return;
    try {
      const token = await ensureCsrf();
      const res = await api(
        '/api/searches/leads/saved/' + encodeURIComponent(currentLeadId) +
        '/activities/' + encodeURIComponent(activityId),
        { method: 'DELETE', headers: { 'X-CSRF-Token': token } }
      );
      if (!res.ok) {
        showToast((res.data && res.data.error) || 'Não foi possível eliminar a actividade.', 'error');
        return;
      }
      showToast('Actividade eliminada.', 'success');
      loadLeadActivities();
    } catch (_) {
      showToast('Erro de rede ao eliminar a actividade.', 'error');
    }
  }

  async function clearLeadActivities() {
    if (!currentLeadId) return;
    const ok = await openConfirmModal(
      'Serão eliminadas todas as actividades deste lead (incluindo alterações de estado). As notas e os agendamentos serão preservados.'
    );
    if (!ok) return;
    try {
      const token = await ensureCsrf();
      const res = await api(
        '/api/searches/leads/saved/' + encodeURIComponent(currentLeadId) + '/activities',
        { method: 'DELETE', headers: { 'X-CSRF-Token': token } }
      );
      if (!res.ok) {
        showToast((res.data && res.data.error) || 'Não foi possível limpar o histórico.', 'error');
        return;
      }
      const n = (res.data && res.data.deletedCount) || 0;
      showToast(n + ' actividade' + (n === 1 ? '' : 's') + ' eliminada' + (n === 1 ? '' : 's') + '.', 'success');
      loadLeadActivities();
    } catch (_) {
      showToast('Erro de rede ao limpar actividades.', 'error');
    }
  }


  function hideLeadSubpanels() {
    const fullA = $('#leads-activities-full-panel');
    const fullP = $('#leads-appointments-full-panel');
    if (fullA) fullA.hidden = true;
    if (fullP) fullP.hidden = true;
  }

  function showLeadDetailOnly() {
    hideLeadSubpanels();
    const list = $('#leads-list-panel');
    const detail = $('#leads-detail-panel');
    if (list) list.hidden = true;
    if (detail) detail.hidden = false;
  }

  async function openActivitiesFullView() {
    if (!currentLeadId) return;
    const list = $('#leads-list-panel');
    const detail = $('#leads-detail-panel');
    const full = $('#leads-activities-full-panel');
    const fullAppt = $('#leads-appointments-full-panel');
    if (list) list.hidden = true;
    if (detail) detail.hidden = true;
    if (fullAppt) fullAppt.hidden = true;
    if (full) full.hidden = false;
    const sub = $('#leads-activities-full-sub');
    if (sub) sub.textContent = (currentLeadName || 'Lead') + ' · actividades';
    activitiesFullPage = 1;
    await loadActivitiesFull();
  }

  async function loadActivitiesFull() {
    const list = $('#leads-activities-full-list');
    if (!list || !currentLeadId) return;
    list.innerHTML = '';
    const loading = document.createElement('p');
    loading.className = 'empty-hint';
    loading.textContent = 'A carregar…';
    list.appendChild(loading);
    try {
      const qEl = $('#leads-activities-full-q');
      const typeEl = $('#leads-activities-full-type');
      const q = qEl ? String(qEl.value || '').trim() : '';
      const type = typeEl ? String(typeEl.value || '') : '';
      const offset = (Math.max(1, activitiesFullPage) - 1) * ACTIVITIES_FULL_PAGE_SIZE;
      const params = new URLSearchParams();
      params.set('limit', String(ACTIVITIES_FULL_PAGE_SIZE));
      params.set('offset', String(offset));
      if (q) params.set('q', q);
      if (type) params.set('activityType', type);
      const res = await api(
        '/api/searches/leads/saved/' + encodeURIComponent(currentLeadId) +
        '/activities?' + params.toString()
      );
      if (!res.ok) {
        list.innerHTML = '<p class="empty-hint">Não foi possível carregar o histórico.</p>';
        return;
      }
      const items = (res.data && res.data.items) || [];
      let total = (res.data && res.data.total != null) ? Number(res.data.total) : items.length;
      if (!Number.isFinite(total) || total < 0) total = items.length;
      const pages = Math.max(1, Math.ceil(total / ACTIVITIES_FULL_PAGE_SIZE) || 1);
      if (activitiesFullPage > pages) {
        activitiesFullPage = pages;
        // Re-fetch the last valid page when current page became empty (e.g. after delete)
        if (items.length === 0 && total > 0) {
          return loadActivitiesFull();
        }
      }
      if (activitiesFullPage < 1) activitiesFullPage = 1;
      activitiesFullCache = { items: items, total: total, page: activitiesFullPage };
      renderActivitiesFullPageFromServer(items, total);
    } catch (_) {
      list.innerHTML = '<p class="empty-hint">Erro de rede.</p>';
    }
  }

  function renderActivitiesFullPage() {
    // Re-entry from filter UI: reload from server
    loadActivitiesFull();
  }

  function renderActivitiesFullPageFromServer(items, total) {
    const list = $('#leads-activities-full-list');
    const pag = $('#leads-activities-full-pagination');
    if (!list) return;
    list.innerHTML = '';
    if (!items.length) {
      list.innerHTML = '<p class="empty-hint">Sem actividades neste filtro.</p>';
    } else {
      items.forEach((a) => {
        const el = document.createElement('div');
        el.className = 'leads-crm-activity' + (a.activityType === 'status_change' ? ' is-status' : '');
        const head = document.createElement('div');
        head.className = 'leads-crm-activity-head';
        const meta = document.createElement('div');
        meta.className = 'leads-crm-activity-meta';
        meta.textContent = formatDate(a.occurredAt);
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'btn btn-ghost btn-sm';
        delBtn.textContent = 'Eliminar';
        delBtn.addEventListener('click', () => {
          const summary = (ACTIVITY_TYPE_LABEL[a.activityType] || '') + (a.description ? (': ' + String(a.description).slice(0, 80)) : '');
          deleteOneActivity(a.id, summary).then(() => { loadActivitiesFull(); loadLeadActivities(); });
        });
        head.appendChild(meta);
        head.appendChild(delBtn);
        const typeDiv = document.createElement('div');
        typeDiv.className = 'leads-crm-activity-type';
        typeDiv.textContent = ACTIVITY_TYPE_LABEL[a.activityType] || a.activityType || 'Actividade';
        const desc = document.createElement('div');
        desc.className = 'leads-crm-activity-desc';
        desc.style.webkitLineClamp = 'unset';
        desc.style.display = 'block';
        desc.textContent = a.description || '';
        el.appendChild(head);
        el.appendChild(typeDiv);
        el.appendChild(desc);
        if (a.outcome) {
          const out = document.createElement('div');
          out.className = 'leads-crm-activity-outcome';
          out.textContent = a.outcome;
          el.appendChild(out);
        }
        list.appendChild(el);
      });
    }
    if (pag) {
      pag.innerHTML = '';
      const pages = Math.max(1, Math.ceil(Math.max(0, total) / ACTIVITIES_FULL_PAGE_SIZE));
      if (pages <= 1) { pag.hidden = true; return; }
      pag.hidden = false;
      const info = document.createElement('span');
      info.textContent = 'Página ' + activitiesFullPage + ' / ' + pages + ' (' + total + ')';
      pag.appendChild(info);
      const prev = document.createElement('button');
      prev.type = 'button'; prev.className = 'btn btn-ghost btn-sm'; prev.textContent = 'Anterior';
      prev.disabled = activitiesFullPage <= 1;
      prev.addEventListener('click', () => { activitiesFullPage -= 1; loadActivitiesFull(); });
      const next = document.createElement('button');
      next.type = 'button'; next.className = 'btn btn-ghost btn-sm'; next.textContent = 'Seguinte';
      next.disabled = activitiesFullPage >= pages;
      next.addEventListener('click', () => { activitiesFullPage += 1; loadActivitiesFull(); });
      pag.appendChild(prev); pag.appendChild(next);
    }
  }


  async function openAppointmentsFullView() {
    if (!currentLeadId) return;
    const list = $('#leads-list-panel');
    const detail = $('#leads-detail-panel');
    const fullA = $('#leads-activities-full-panel');
    const full = $('#leads-appointments-full-panel');
    if (list) list.hidden = true;
    if (detail) detail.hidden = true;
    if (fullA) fullA.hidden = true;
    if (full) full.hidden = false;
    const sub = $('#leads-appointments-full-sub');
    if (sub) sub.textContent = (currentLeadName || 'Lead') + ' · agendamentos';
    await loadAppointmentsFull();
  }

  async function loadAppointmentsFull() {
    const list = $('#leads-appointments-full-list');
    const stats = $('#leads-appointments-full-stats');
    if (!list || !currentLeadId) return;
    list.innerHTML = '';
    try {
      const res = await api('/api/searches/leads/saved/' + encodeURIComponent(currentLeadId) + '/appointments');
      if (!res.ok) {
        list.innerHTML = '<p class="empty-hint">Não foi possível carregar.</p>';
        return;
      }
      const data = res.data || {};
      const upcomingAll = data.upcoming || [];
      const overdue = [];
      const upcoming = [];
      upcomingAll.forEach((a) => {
        if (isAppointmentOverdue(a)) overdue.push(a);
        else upcoming.push(a);
      });
      const completed = data.completed || [];
      const cancelled = data.cancelled || [];
      if (stats) {
        stats.innerHTML = '';
        [
          ['Próximos', upcoming.length],
          ['Atrasados', overdue.length],
          ['Concluídos', completed.length],
          ['Cancelados', cancelled.length],
        ].forEach(([lab, n]) => {
          const d = document.createElement('div');
          d.className = 'leads-crm-appt-stat';
          d.innerHTML = '<div class="leads-crm-appt-stat-label"></div><div class="leads-crm-appt-stat-value"></div>';
          d.querySelector('.leads-crm-appt-stat-label').textContent = lab;
          d.querySelector('.leads-crm-appt-stat-value').textContent = String(n);
          stats.appendChild(d);
        });
      }
      function group(title, items, withActions, isOd) {
        if (!items.length) return;
        const g = document.createElement('div');
        g.className = 'leads-crm-appt-group' + (isOd ? ' is-overdue' : '');
        const h = document.createElement('h4');
        h.className = 'leads-crm-appt-group-title';
        h.textContent = title + ' (' + items.length + ')';
        g.appendChild(h);
        items.forEach((a) => g.appendChild(buildAppointmentCard(a, withActions, !!isOd)));
        list.appendChild(g);
      }
      if (!overdue.length && !upcoming.length && !completed.length && !cancelled.length) {
        list.innerHTML = '<p class="empty-hint">Sem agendamentos.</p>';
        return;
      }
      group('Atrasados', overdue, true, true);
      group('Próximos', upcoming, true, false);
      group('Concluídos', completed, false, false);
      group('Cancelados', cancelled, false, false);
    } catch (_) {
      list.innerHTML = '<p class="empty-hint">Erro de rede.</p>';
    }
  }

  function bindLeadsFiltersOnce() {
    if (leadsFiltersBound) return;
    leadsFiltersBound = true;
    const reload = () => {
      leadsPage = 1;
      loadLeads();
    };
    ['leads-status', 'leads-category', 'leads-sort'].forEach((id) => {
      const el = $('#' + id);
      if (el) el.addEventListener('change', () => { selectedLeadIds.clear(); reload(); });
    });
    const q = $('#leads-q');
    let t = null;
    if (q) {
      q.addEventListener('input', () => {
        selectedLeadIds.clear();
        if (t) clearTimeout(t);
        t = setTimeout(reload, 350);
      });
    }
    const clearBtn = $('#leads-clear-filters');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        selectedLeadIds.clear();
        if ($('#leads-q')) $('#leads-q').value = '';
        if ($('#leads-status')) $('#leads-status').value = '';
        if ($('#leads-category')) $('#leads-category').value = '';
        if ($('#leads-sort')) $('#leads-sort').value = 'recent';
        leadsPage = 1;
        loadLeads();
      });
    }
    const back = $('#leads-back');
    if (back) {
      back.addEventListener('click', () => {
        showLeadsList();
        if (leadsReturnState) {
          leadsPage = leadsReturnState.page || 1;
          if ($('#leads-q')) $('#leads-q').value = leadsReturnState.q || '';
          if ($('#leads-status')) $('#leads-status').value = leadsReturnState.status || '';
          if ($('#leads-category')) $('#leads-category').value = leadsReturnState.category || '';
          if ($('#leads-sort')) $('#leads-sort').value = leadsReturnState.sort || 'recent';
        }
        loadLeads();
      });
    }
    const saveNotes = $('#leads-notes-save');
    if (saveNotes) {
      saveNotes.addEventListener('click', () => saveLeadNotes());
    }
    const editNotes = $('#leads-notes-edit-btn');
    if (editNotes) {
      editNotes.addEventListener('click', () => startEditNotes());
    }
    const cancelNotes = $('#leads-notes-cancel');
    if (cancelNotes) {
      cancelNotes.addEventListener('click', () => cancelEditNotes());
    }
    const st = $('#leads-detail-status');
    if (st) {
      st.addEventListener('change', () => saveLeadStatus());
    }
    const btnAct = $('#leads-btn-add-activity');
    if (btnAct) btnAct.addEventListener('click', () => showActivityForm(true));
    const actCancel = $('#leads-activity-cancel');
    if (actCancel) actCancel.addEventListener('click', () => showActivityForm(false));
    const actSave = $('#leads-activity-save');
    if (actSave) actSave.addEventListener('click', () => saveActivity());
    const btnAppt = $('#leads-btn-add-appointment');
    if (btnAppt) btnAppt.addEventListener('click', () => showAppointmentForm(true));
    const btnApptSum = $('#leads-btn-add-appointment-summary');
    if (btnApptSum) btnApptSum.addEventListener('click', () => showAppointmentForm(true));
    const apptCancel = $('#leads-appointment-cancel');
    if (apptCancel) apptCancel.addEventListener('click', () => showAppointmentForm(false));
    const apptSave = $('#leads-appointment-save');
    if (apptSave) apptSave.addEventListener('click', () => saveAppointment());
  }

  async function loadLeads(opts) {
    const options = opts || {};
    bindLeadsFiltersOnce();
    showLeadsList();
    const body = $('#leads-body');
    if (!body) return;
    const requestId = ++leadsRequestSeq;
    body.innerHTML = '';
    const loading = document.createElement('tr');
    const tdLoad = document.createElement('td');
    tdLoad.colSpan = 6;
    tdLoad.textContent = 'A carregar leads…';
    loading.appendChild(tdLoad);
    body.appendChild(loading);

    try {
      const params = leadsQueryParams();
      const res = await api('/api/searches/leads/saved?' + params.toString());
      if (requestId !== leadsRequestSeq) return;
      body.innerHTML = '';
      if (!res.ok) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 6;
        td.textContent = res.status === 401
          ? 'Inicia sessão para ver os leads.'
          : res.status === 403
            ? 'Verifica o email para aceder aos leads.'
            : 'Não foi possível carregar os leads.';
        tr.appendChild(td);
        body.appendChild(tr);
        updateLeadsStats({}, null);
        renderLeadsPagination();
        return;
      }
      const data = res.data || {};
      const items = Array.isArray(data.items) ? data.items : [];
      leadsTotal = data.total != null ? Number(data.total) : items.length;
      updateLeadsStats(data.statusCounts || {}, data.totalLeads != null ? data.totalLeads : leadsTotal);
      fillLeadsCategories(data.categories || [], ($('#leads-category') && $('#leads-category').value) || '');

      if (!items.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 7;
        td.textContent = leadsTotal === 0 && !params.get('q') && !params.get('status') && !params.get('category')
          ? 'Ainda não há leads guardados.'
          : 'Nenhum lead corresponde aos filtros.';
        tr.appendChild(td);
        body.appendChild(tr);
        renderLeadsPagination();
        if (options.scrollToTop) scrollActiveViewToTop();
        return;
      }

      items.forEach((item) => {
        const tr = document.createElement('tr');
        const tdCheck = document.createElement('td');
        tdCheck.className = 'col-check';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'lead-check';
        cb.value = item.id || '';
        cb.checked = selectedLeadIds.has(String(item.id));
        cb.addEventListener('click', (e) => e.stopPropagation());
        cb.addEventListener('change', () => {
          const id = String(item.id);
          if (cb.checked) selectedLeadIds.add(id);
          else selectedLeadIds.delete(id);
          updateLeadsSelectionUi();
        });
        tdCheck.appendChild(cb);
        tr.appendChild(tdCheck);
        const cells = [
          item.name || '—',
          item.category || '—',
          item.phone || '—',
          null,
          formatDate(item.createdAt),
        ];
        cells.forEach((val, idx) => {
          const td = document.createElement('td');
          if (idx === 3) {
            td.appendChild(statusBadge(item.status));
          } else {
            td.textContent = val == null ? '—' : String(val);
          }
          tr.appendChild(td);
        });
        const tdAction = document.createElement('td');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-ghost btn-sm';
        btn.textContent = 'Detalhes';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          openLeadDetail(item.id);
        });
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'btn btn-danger btn-sm';
        delBtn.textContent = 'Eliminar';
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteOneLead(item.id, item.name || 'este lead');
        });
        tdAction.appendChild(btn);
        tdAction.appendChild(document.createTextNode(' '));
        tdAction.appendChild(delBtn);
        tr.appendChild(tdAction);
        tr.style.cursor = 'pointer';
        tr.addEventListener('click', () => openLeadDetail(item.id));
        body.appendChild(tr);
      });
      updateLeadsSelectionUi();
      renderLeadsPagination();
      if (options.scrollToTop) scrollActiveViewToTop();
    } catch (_) {
      if (requestId !== leadsRequestSeq) return;
      body.innerHTML = '';
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 7;
      td.textContent = 'Não foi possível carregar os leads.';
      tr.appendChild(td);
      body.appendChild(tr);
    }
  }

  function normalizeLeadPayload(raw) {
    if (!raw || typeof raw !== 'object') return {};
    return {
      id: raw.id != null ? raw.id : raw.lead_id,
      name: raw.name,
      phone: raw.phone != null ? raw.phone : raw.phone_number,
      email: raw.email,
      address: raw.address,
      website: raw.website != null ? raw.website : raw.web_site,
      rating: raw.rating != null ? raw.rating : null,
      reviewsCount: raw.reviewsCount != null ? raw.reviewsCount : raw.reviews_count,
      category: raw.category,
      createdAt: raw.createdAt != null ? raw.createdAt : raw.created_at,
      status: raw.status,
      notes: raw.notes,
      lat: raw.lat,
      lng: raw.lng,
    };
  }

  /**
   * Always render the Informações card structure.
   * Empty values show "—" so the card never collapses to blank.
   */
  function fillLeadInfoFields(fieldsEl, lead) {
    if (!fieldsEl) return;
    fieldsEl.innerHTML = '';
    const data = normalizeLeadPayload(lead || {});
    function add(label, value, opts) {
      appendDetailField(fieldsEl, label, value, opts || null);
    }
    add(
      'Telefone',
      data.phone,
      hasValue(data.phone) ? { tel: String(data.phone).replace(/\s+/g, '') } : null
    );
    add(
      'Email',
      data.email,
      hasValue(data.email) ? { mailto: String(data.email).trim() } : null
    );
    add('Endereço', data.address);
    {
      let href = null;
      if (hasValue(data.website)) {
        href = String(data.website).trim();
        if (!/^https?:\/\//i.test(href)) href = 'https://' + href;
      }
      add('Website', data.website, href ? { href: href } : null);
    }
    const ratingBits = [];
    if (data.rating != null && String(data.rating).trim() !== '') ratingBits.push(String(data.rating));
    if (data.reviewsCount != null && String(data.reviewsCount).trim() !== '') {
      ratingBits.push(String(data.reviewsCount) + ' avaliações');
    }
    add('Avaliação', ratingBits.length ? ratingBits.join(' · ') : null);
    add('Categoria', data.category);
    add('Guardado em', data.createdAt != null ? formatDate(data.createdAt) : null);
  }

  function setDetailField(label, value, opts) {
    const row = document.createElement('div');
    row.className = 'leads-crm-field';
    const lab = document.createElement('span');
    lab.className = 'leads-crm-field-label';
    lab.textContent = label;
    const val = document.createElement('span');
    val.className = 'leads-crm-field-value';
    const present = hasValue(value);
    const text = present ? String(value).trim() : '—';
    // Only create actionable links when a real value exists
    if (present && opts && opts.href) {
      const a = document.createElement('a');
      a.href = opts.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = text;
      val.appendChild(a);
    } else if (present && opts && opts.tel) {
      const a = document.createElement('a');
      a.href = 'tel:' + opts.tel;
      a.textContent = text;
      val.appendChild(a);
    } else if (present && opts && opts.mailto) {
      const a = document.createElement('a');
      a.href = 'mailto:' + opts.mailto;
      a.textContent = text;
      val.appendChild(a);
    } else {
      val.textContent = text;
    }
    row.appendChild(lab);
    row.appendChild(val);
    return row;
  }

  function appendDetailField(parent, label, value, opts) {
    const row = setDetailField(label, value, opts);
    if (row && parent) parent.appendChild(row);
  }

  let currentLeadNotes = '';

  function setNotesViewMode(editing) {
    const edit = $('#leads-notes-edit');
    const preview = $('#leads-notes-preview');
    const editBtn = $('#leads-notes-edit-btn');
    if (edit) edit.hidden = !editing;
    if (preview) preview.hidden = !!editing;
    if (editBtn) editBtn.hidden = !!editing;
  }

  function renderNotesPreview(notes) {
    currentLeadNotes = notes != null ? String(notes) : '';
    const preview = $('#leads-notes-preview');
    const notesEl = $('#leads-notes-textarea');
    const has = currentLeadNotes.trim().length > 0;
    if (preview) {
      if (!preview.hidden || true) {
        preview.textContent = has ? currentLeadNotes : 'Sem notas.';
      }
    }
    if (notesEl) notesEl.value = currentLeadNotes;
    setNotesViewMode(false);
  }

  function startEditNotes() {
    const notesEl = $('#leads-notes-textarea');
    if (notesEl) notesEl.value = currentLeadNotes;
    const statusEl = $('#leads-notes-msg');
    if (statusEl) statusEl.textContent = '';
    setNotesViewMode(true);
    if (notesEl) notesEl.focus();
  }

  function cancelEditNotes() {
    const notesEl = $('#leads-notes-textarea');
    if (notesEl) notesEl.value = currentLeadNotes;
    const statusEl = $('#leads-notes-msg');
    if (statusEl) statusEl.textContent = '';
    setNotesViewMode(false);
  }

  async function openLeadDetail(id) {
    hideLeadSubpanels();
    if (!id) return;
    leadsReturnState = {
      page: leadsPage,
      q: ($('#leads-q') && $('#leads-q').value) || '',
      status: ($('#leads-status') && $('#leads-status').value) || '',
      category: ($('#leads-category') && $('#leads-category').value) || '',
      sort: ($('#leads-sort') && $('#leads-sort').value) || 'recent',
    };
    showLeadsDetail();
    currentLeadId = id;
    currentLeadName = '';
    const nameEl = $('#leads-detail-name');
    const fields = $('#leads-detail-fields');
    const meta = $('#leads-detail-meta');
    const actions = $('#leads-detail-actions');
    const notesStatus = $('#leads-notes-msg');
    const statusMsg = $('#leads-status-msg');
    const statusSel = $('#leads-detail-status');
    if (nameEl) nameEl.textContent = 'A carregar…';
    if (fields) fields.innerHTML = '';
    if (meta) meta.innerHTML = '';
    if (actions) actions.innerHTML = '';
    if (notesStatus) notesStatus.textContent = '';
    if (statusMsg) statusMsg.textContent = '';
    renderNotesPreview('');
    const nextBox = $('#leads-next-appt');
    if (nextBox) {
      nextBox.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'empty-hint';
      p.id = 'leads-next-appt-empty';
      p.textContent = 'Sem agendamentos futuros.';
      nextBox.appendChild(p);
    }

    try {
      const res = await api('/api/searches/leads/saved/' + encodeURIComponent(id));
      // Ignore stale responses if the user already opened another lead
      if (currentLeadId !== id) return;
      if (!res.ok || !res.data || !res.data.lead) {
        if (nameEl) nameEl.textContent = 'Lead não encontrado';
        return;
      }
      const lead = res.data.lead;
      if (currentLeadId !== id && currentLeadId !== lead.id) return;
      currentLeadId = lead.id;
      currentLeadName = lead.name || '';
      if (nameEl) nameEl.textContent = lead.name || 'Estabelecimento';

      if (meta) {
        meta.innerHTML = '';
        const bits = [];
        if (hasValue(lead.category)) bits.push(String(lead.category).trim());
        if (hasValue(lead.address)) bits.push(String(lead.address).trim());
        bits.forEach((b, i) => {
          if (i) {
            const sep = document.createElement('span');
            sep.className = 'leads-crm-detail-meta-sep';
            sep.textContent = '·';
            meta.appendChild(sep);
          }
          const span = document.createElement('span');
          span.className = 'leads-crm-detail-meta-item';
          span.textContent = b;
          meta.appendChild(span);
        });
      }

      if (actions) {
        actions.innerHTML = '';
        if (hasValue(lead.phone)) {
          const tel = document.createElement('a');
          tel.className = 'btn btn-secondary btn-sm';
          tel.href = 'tel:' + String(lead.phone).replace(/\s+/g, '');
          tel.textContent = 'Ligar';
          actions.appendChild(tel);
          const wa = document.createElement('a');
          wa.className = 'btn btn-ghost btn-sm';
          const digits = String(lead.phone).replace(/\D/g, '');
          wa.href = 'https://wa.me/' + digits;
          wa.target = '_blank';
          wa.rel = 'noopener noreferrer';
          wa.textContent = 'WhatsApp';
          actions.appendChild(wa);
        }
        if (hasValue(lead.website)) {
          let href = String(lead.website).trim();
          if (!/^https?:\/\//i.test(href)) href = 'https://' + href;
          const web = document.createElement('a');
          web.className = 'btn btn-ghost btn-sm';
          web.href = href;
          web.target = '_blank';
          web.rel = 'noopener noreferrer';
          web.textContent = 'Website';
          actions.appendChild(web);
        }
      }

      if (fields) {
        fillLeadInfoFields(fields, lead);
      }
      if (statusSel) statusSel.value = lead.status || 'Por contactar';
      renderNotesPreview(lead.notes);
      showActivityForm(false);
      showAppointmentForm(false);
      loadLeadActivities();
      loadLeadAppointments();
    } catch (_) {
      if (nameEl) nameEl.textContent = 'Erro ao carregar o lead';
    }
  }

  async function saveLeadNotes() {
    if (!currentLeadId) return;
    const notesEl = $('#leads-notes-textarea');
    const statusEl = $('#leads-notes-msg');
    const btn = $('#leads-notes-save');
    const notes = notesEl ? notesEl.value : '';
    if (notes.length > 10000) {
      if (statusEl) statusEl.textContent = 'Máximo de 10.000 caracteres.';
      return;
    }
    if (btn) btn.disabled = true;
    if (statusEl) statusEl.textContent = 'A guardar…';
    try {
      const token = await ensureCsrf();
      const res = await api('/api/searches/leads/saved/' + encodeURIComponent(currentLeadId), {
        method: 'PATCH',
        headers: { 'X-CSRF-Token': token },
        body: { notes },
      });
      if (!res.ok) {
        if (statusEl) statusEl.textContent = (res.data && res.data.error) || 'Não foi possível guardar.';
        return;
      }
      if (statusEl) statusEl.textContent = 'Notas guardadas.';
      currentLeadNotes = notes;
      renderNotesPreview(notes);
      showToast('Notas guardadas.', 'success');
    } catch (_) {
      if (statusEl) statusEl.textContent = 'Erro de rede.';
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function saveLeadStatus() {
    if (!currentLeadId) return;
    const statusSel = $('#leads-detail-status');
    const statusMsg = $('#leads-status-msg');
    const status = statusSel ? statusSel.value : '';
    if (statusMsg) statusMsg.textContent = 'A guardar…';
    try {
      const token = await ensureCsrf();
      const res = await api('/api/searches/leads/saved/' + encodeURIComponent(currentLeadId), {
        method: 'PATCH',
        headers: { 'X-CSRF-Token': token },
        body: { status },
      });
      if (!res.ok) {
        if (statusMsg) statusMsg.textContent = (res.data && res.data.error) || 'Não foi possível atualizar o estado.';
        return;
      }
      if (statusMsg) statusMsg.textContent = 'Estado atualizado.';
      showToast('Estado atualizado.', 'success');
      loadLeadActivities();
    } catch (_) {
      if (statusMsg) statusMsg.textContent = 'Erro de rede.';
    }
  }

  const ACTIVITY_TYPE_LABEL = {
    phone_call: 'Chamada telefónica',
    whatsapp: 'Mensagem WhatsApp',
    meeting: 'Reunião',
    other: 'Outro contacto',
    status_change: 'Alteração de estado',
  };

  const APPT_STATUS_LABEL = {
    scheduled: 'Agendado',
    completed: 'Concluído',
    cancelled: 'Cancelado',
  };

  function toDatetimeLocalValue(d) {
    const x = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(x.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate()) +
      'T' + pad(x.getHours()) + ':' + pad(x.getMinutes());
  }

  function showActivityForm(show) {
    const form = $('#leads-activity-form');
    if (!form) return;
    form.hidden = !show;
    if (show) {
      const when = $('#leads-activity-when');
      if (when && !when.value) when.value = toDatetimeLocalValue(new Date());
      const msg = $('#leads-activity-msg');
      if (msg) msg.textContent = '';
    }
  }

  function showAppointmentForm(show, appt) {
    const form = $('#leads-appointment-form');
    if (!form) return;
    form.hidden = !show;
    const actOpen = $('#leads-activity-form') && !$('#leads-activity-form').hidden;
    setFormBackdrop(!!show || !!actOpen);
    const idEl = $('#leads-appointment-edit-id');
    const titleEl = $('#leads-appointment-title');
    const whenEl = $('#leads-appointment-when');
    const descEl = $('#leads-appointment-desc');
    const msg = $('#leads-appointment-msg');
    if (msg) msg.textContent = '';
    if (!show) {
      if (idEl) idEl.value = '';
      if (titleEl) titleEl.value = '';
      if (whenEl) whenEl.value = '';
      if (descEl) descEl.value = '';
      return;
    }
    if (appt) {
      if (idEl) idEl.value = appt.id || '';
      if (titleEl) titleEl.value = appt.title || '';
      if (whenEl) whenEl.value = toDatetimeLocalValue(appt.scheduledAt);
      if (descEl) descEl.value = appt.description || '';
    } else {
      if (idEl) idEl.value = '';
      if (titleEl) titleEl.value = '';
      if (whenEl) whenEl.value = toDatetimeLocalValue(new Date());
      if (descEl) descEl.value = '';
    }
  }

  async function loadLeadActivities() {
    const list = $('#leads-activities-list');
    if (!list || !currentLeadId) return;
    list.innerHTML = '';
    const loading = document.createElement('p');
    loading.className = 'empty-hint';
    loading.textContent = 'A carregar histórico…';
    list.appendChild(loading);
    try {
      const res = await api('/api/searches/leads/saved/' + encodeURIComponent(currentLeadId) + '/activities');
      list.innerHTML = '';
      if (!res.ok) {
        const p = document.createElement('p');
        p.className = 'empty-hint';
        p.textContent = 'Não foi possível carregar o histórico.';
        list.appendChild(p);
        return;
      }
      const items = (res.data && res.data.items) || [];
      const total = (res.data && res.data.total != null) ? Number(res.data.total) : items.length;
      const countEl = $('#leads-activities-count');
      if (countEl) {
        if (total > 0) { countEl.hidden = false; countEl.textContent = String(total); }
        else { countEl.hidden = true; countEl.textContent = ''; }
      }
      const meta = $('#leads-activities-preview-meta');
      if (!items.length) {
        const p = document.createElement('p');
        p.className = 'empty-hint';
        p.id = 'leads-activities-empty';
        p.textContent = 'Ainda não existem actividades registadas.';
        list.appendChild(p);
        if (meta) meta.textContent = '';
        return;
      }
      const preview = items.slice(0, 3);
      if (meta) meta.textContent = preview.length + ' de ' + total + ' actividade' + (total === 1 ? '' : 's');
      preview.forEach((a) => {
        const el = document.createElement('div');
        el.className = 'leads-crm-activity' + (a.activityType === 'status_change' ? ' is-status' : '');
        const head = document.createElement('div');
        head.className = 'leads-crm-activity-head';
        const meta = document.createElement('div');
        meta.className = 'leads-crm-activity-meta';
        meta.textContent = formatDate(a.occurredAt);
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'btn btn-ghost btn-sm leads-crm-activity-delete';
        delBtn.textContent = 'Eliminar';
        delBtn.addEventListener('click', () => {
          const summary = (ACTIVITY_TYPE_LABEL[a.activityType] || a.activityType || '') +
            (a.description ? (': ' + String(a.description).slice(0, 80)) : '');
          deleteOneActivity(a.id, summary);
        });
        head.appendChild(meta);
        head.appendChild(delBtn);
        const type = document.createElement('div');
        type.className = 'leads-crm-activity-type';
        type.textContent = ACTIVITY_TYPE_LABEL[a.activityType] || a.activityType || 'Actividade';
        const desc = document.createElement('div');
        desc.className = 'leads-crm-activity-desc';
        desc.textContent = a.description || '';
        el.appendChild(head);
        el.appendChild(type);
        el.appendChild(desc);
        if (a.outcome) {
          const out = document.createElement('div');
          out.className = 'leads-crm-activity-outcome';
          out.textContent = a.outcome;
          el.appendChild(out);
        }
        list.appendChild(el);
      });
    } catch (_) {
      list.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'empty-hint';
      p.textContent = 'Erro de rede ao carregar o histórico.';
      list.appendChild(p);
    }
  }

  async function saveActivity() {
    if (!currentLeadId) return;
    const typeEl = $('#leads-activity-type');
    const whenEl = $('#leads-activity-when');
    const descEl = $('#leads-activity-desc');
    const outEl = $('#leads-activity-outcome');
    const msg = $('#leads-activity-msg');
    const btn = $('#leads-activity-save');
    const description = descEl ? String(descEl.value || '').trim() : '';
    if (!description) {
      if (msg) msg.textContent = 'A descrição é obrigatória.';
      return;
    }
    let occurredAt = null;
    if (whenEl && whenEl.value) {
      const d = new Date(whenEl.value);
      if (Number.isNaN(d.getTime())) {
        if (msg) msg.textContent = 'Data/hora inválida.';
        return;
      }
      occurredAt = d.toISOString();
    }
    if (btn) btn.disabled = true;
    if (msg) msg.textContent = 'A guardar…';
    try {
      const token = await ensureCsrf();
      const res = await api('/api/searches/leads/saved/' + encodeURIComponent(currentLeadId) + '/activities', {
        method: 'POST',
        headers: { 'X-CSRF-Token': token },
        body: {
          activityType: typeEl ? typeEl.value : 'other',
          description,
          outcome: outEl ? outEl.value : '',
          occurredAt,
        },
      });
      if (!res.ok) {
        if (msg) msg.textContent = (res.data && res.data.error) || 'Não foi possível guardar.';
        return;
      }
      if (msg) msg.textContent = 'Actividade registada.';
      if (descEl) descEl.value = '';
      if (outEl) outEl.value = '';
      showActivityForm(false);
      showToast('Actividade registada.', 'success');
      loadLeadActivities();
    } catch (_) {
      if (msg) msg.textContent = 'Erro de rede.';
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function isAppointmentOverdue(a) {
    if (!a || a.status !== 'scheduled') return false;
    const t = a.scheduledAt ? new Date(a.scheduledAt).getTime() : NaN;
    return !Number.isNaN(t) && t < Date.now();
  }

  function updateNextAppointmentSide(upcomingFuture) {
    const box = $('#leads-next-appt');
    if (!box) return;
    box.innerHTML = '';
    if (!upcomingFuture || !upcomingFuture.length) {
      const p = document.createElement('p');
      p.className = 'empty-hint';
      p.id = 'leads-next-appt-empty';
      p.textContent = 'Sem agendamentos futuros.';
      box.appendChild(p);
      return;
    }
    const sorted = upcomingFuture.slice().sort((a, b) => {
      return new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
    });
    const next = sorted[0];
    const title = document.createElement('div');
    title.className = 'leads-crm-next-appt-title';
    title.textContent = next.title || 'Agendamento';
    const when = document.createElement('div');
    when.className = 'leads-crm-next-appt-when';
    when.textContent = formatDate(next.scheduledAt);
    box.appendChild(title);
    box.appendChild(when);
  }

  async function loadLeadAppointments() {
    const list = $('#leads-appointments-list');
    if (!list || !currentLeadId) return;
    list.innerHTML = '';
    const loading = document.createElement('p');
    loading.className = 'empty-hint';
    loading.textContent = 'A carregar agendamentos…';
    list.appendChild(loading);
    try {
      const res = await api('/api/searches/leads/saved/' + encodeURIComponent(currentLeadId) + '/appointments');
      list.innerHTML = '';
      if (!res.ok) {
        const p = document.createElement('p');
        p.className = 'empty-hint';
        p.textContent = 'Não foi possível carregar os agendamentos.';
        list.appendChild(p);
        updateNextAppointmentSide([]);
        return;
      }
      const data = res.data || {};
      const upcomingAll = data.upcoming || [];
      const overdue = [];
      const upcoming = [];
      upcomingAll.forEach((a) => {
        if (isAppointmentOverdue(a)) overdue.push(a);
        else upcoming.push(a);
      });
      overdue.sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
      upcoming.sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
      const completed = data.completed || [];
      const cancelled = data.cancelled || [];
      updateNextAppointmentSide(upcoming);
      appointmentsFullCache = { overdue, upcoming, completed, cancelled };

      const total = overdue.length + upcoming.length + completed.length + cancelled.length;
      const countEl = $('#leads-appointments-count');
      if (countEl) {
        if (total > 0) { countEl.hidden = false; countEl.textContent = String(total); }
        else { countEl.hidden = true; }
      }
      const meta = $('#leads-appointments-preview-meta');
      if (meta) {
        const bits = [];
        if (completed.length) bits.push('Concluídos (' + completed.length + ')');
        if (cancelled.length) bits.push('Cancelados (' + cancelled.length + ')');
        meta.textContent = bits.join(' · ');
      }

      if (!overdue.length && !upcoming.length) {
        const p = document.createElement('p');
        p.className = 'empty-hint';
        p.id = 'leads-appointments-empty';
        p.textContent = 'Sem agendamentos futuros.';
        list.appendChild(p);
        return;
      }

      // Preview: max 2 next (overdue first, then upcoming)
      const preview = overdue.concat(upcoming).slice(0, 2);
      preview.forEach((a) => {
        const isOd = isAppointmentOverdue(a);
        list.appendChild(buildAppointmentCard(a, true, isOd));
      });
    } catch (_) {
      list.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'empty-hint';
      p.textContent = 'Erro de rede ao carregar agendamentos.';
      list.appendChild(p);
      updateNextAppointmentSide([]);
    }
  }


  function buildAppointmentCard(a, withActions, isOverdue) {
    const el = document.createElement('div');
    el.className = 'leads-crm-appt' + (isOverdue ? ' is-overdue' : '');
    const title = document.createElement('div');
    title.className = 'leads-crm-appt-title';
    title.textContent = a.title || 'Compromisso';
    const when = document.createElement('div');
    when.className = 'leads-crm-appt-when';
    when.textContent = formatDate(a.scheduledAt);
    const status = document.createElement('span');
    const stClass = isOverdue ? 'is-overdue' : ('is-' + (a.status || 'scheduled'));
    status.className = 'leads-crm-appt-status ' + stClass;
    status.textContent = isOverdue ? 'Atrasado' : (APPT_STATUS_LABEL[a.status] || a.status || '');
    when.appendChild(document.createTextNode(' · '));
    when.appendChild(status);
    el.appendChild(title);
    el.appendChild(when);
    if (a.description) {
      const desc = document.createElement('div');
      desc.className = 'leads-crm-appt-desc';
      desc.textContent = a.description;
      el.appendChild(desc);
    }
    if (withActions && a.status === 'scheduled') {
      const actions = document.createElement('div');
      actions.className = 'leads-crm-appt-actions';
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn btn-ghost btn-sm';
      editBtn.textContent = 'Editar';
      editBtn.addEventListener('click', () => showAppointmentForm(true, a));
      const doneBtn = document.createElement('button');
      doneBtn.type = 'button';
      doneBtn.className = 'btn btn-secondary btn-sm';
      doneBtn.textContent = 'Concluir';
      doneBtn.addEventListener('click', () => completeAppointment(a.id));
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn btn-ghost btn-sm';
      cancelBtn.textContent = 'Cancelar';
      cancelBtn.addEventListener('click', () => {
        if (window.confirm('Cancelar este compromisso? O registo será preservado.')) {
          cancelAppointment(a.id);
        }
      });
      actions.appendChild(editBtn);
      actions.appendChild(doneBtn);
      actions.appendChild(cancelBtn);
      el.appendChild(actions);
    }
    return el;
  }

  async function saveAppointment() {
    if (!currentLeadId) return;
    const idEl = $('#leads-appointment-edit-id');
    const titleEl = $('#leads-appointment-title');
    const whenEl = $('#leads-appointment-when');
    const descEl = $('#leads-appointment-desc');
    const msg = $('#leads-appointment-msg');
    const btn = $('#leads-appointment-save');
    const title = titleEl ? String(titleEl.value || '').trim() : '';
    if (!title) {
      if (msg) msg.textContent = 'O título é obrigatório.';
      return;
    }
    if (!whenEl || !whenEl.value) {
      if (msg) msg.textContent = 'Data e hora são obrigatórias.';
      return;
    }
    const d = new Date(whenEl.value);
    if (Number.isNaN(d.getTime())) {
      if (msg) msg.textContent = 'Data/hora inválida.';
      return;
    }
    const editId = idEl ? idEl.value : '';
    if (btn) btn.disabled = true;
    if (msg) msg.textContent = 'A guardar…';
    try {
      const token = await ensureCsrf();
      const body = {
        title,
        description: descEl ? descEl.value : '',
        scheduledAt: d.toISOString(),
      };
      let res;
      if (editId) {
        res = await api(
          '/api/searches/leads/saved/' + encodeURIComponent(currentLeadId) +
            '/appointments/' + encodeURIComponent(editId),
          { method: 'PATCH', headers: { 'X-CSRF-Token': token }, body }
        );
      } else {
        res = await api(
          '/api/searches/leads/saved/' + encodeURIComponent(currentLeadId) + '/appointments',
          { method: 'POST', headers: { 'X-CSRF-Token': token }, body }
        );
      }
      if (!res.ok) {
        if (msg) msg.textContent = (res.data && res.data.error) || 'Não foi possível guardar.';
        return;
      }
      showAppointmentForm(false);
      showToast(editId ? 'Agendamento atualizado.' : 'Agendamento criado.', 'success');
      loadLeadAppointments();
      loadLeadActivities();
    } catch (_) {
      if (msg) msg.textContent = 'Erro de rede.';
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function completeAppointment(appointmentId) {
    if (!currentLeadId || !appointmentId) return;
    try {
      const token = await ensureCsrf();
      const res = await api(
        '/api/searches/leads/saved/' + encodeURIComponent(currentLeadId) +
          '/appointments/' + encodeURIComponent(appointmentId) + '/complete',
        { method: 'POST', headers: { 'X-CSRF-Token': token }, body: {} }
      );
      if (!res.ok) {
        showToast((res.data && res.data.error) || 'Não foi possível concluir.', 'error');
        return;
      }
      showToast('Compromisso concluído.', 'success');
      loadLeadAppointments();
      loadLeadActivities();
    } catch (_) {
      showToast('Erro de rede.', 'error');
    }
  }

  async function cancelAppointment(appointmentId) {
    if (!currentLeadId || !appointmentId) return;
    try {
      const token = await ensureCsrf();
      const res = await api(
        '/api/searches/leads/saved/' + encodeURIComponent(currentLeadId) +
          '/appointments/' + encodeURIComponent(appointmentId) + '/cancel',
        { method: 'POST', headers: { 'X-CSRF-Token': token }, body: {} }
      );
      if (!res.ok) {
        showToast((res.data && res.data.error) || 'Não foi possível cancelar.', 'error');
        return;
      }
      showToast('Compromisso cancelado.', 'success');
      loadLeadAppointments();
      loadLeadActivities();
    } catch (_) {
      showToast('Erro de rede.', 'error');
    }
  }

  async function loadDashboard() {
    const box = $('#dashboard-recent');
    if (!box) return;
    try {
      const res = await api('/api/searches/dashboard');
      if (!res.ok) {
        ['stat-searches', 'stat-results', 'stat-leads'].forEach((id) => {
          const el = $('#' + id); if (el) el.textContent = '—';
        });
        box.innerHTML = '';
        const empty = document.createElement('p');
        empty.className = 'empty-hint';
        empty.id = 'dashboard-recent-empty';
        empty.textContent = res.status === 401
          ? 'Inicia sessão para ver a atividade da conta.'
          : res.status === 403
            ? 'Verifica o email para aceder aos dados da conta.'
            : 'Não foi possível carregar o dashboard.';
        box.appendChild(empty);
        return;
      }
      const data = res.data || {};
      if ($('#stat-searches')) $('#stat-searches').textContent = String(data.searchesCount != null ? data.searchesCount : '—');
      if ($('#stat-results')) $('#stat-results').textContent = String(data.resultsCount != null ? data.resultsCount : '—');
      if ($('#stat-leads')) $('#stat-leads').textContent = String(data.savedLeadsCount != null ? data.savedLeadsCount : '—');
      box.innerHTML = '';
      const recent = data.recentSearches || [];
      if (!recent.length) {
        const p = document.createElement('p');
        p.className = 'empty-hint';
        p.textContent = 'Ainda não existem pesquisas.';
        box.appendChild(p);
        return;
      }
      const wrap = document.createElement('div');
      wrap.className = 'table-wrap table-wrap-dashboard';
      const table = document.createElement('table');
      table.className = 'data table-dashboard';
      const thead = document.createElement('thead');
      thead.innerHTML = '<tr><th>Categoria</th><th>Localização</th><th>Resultados</th><th>Estado</th><th>Data</th></tr>';
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      recent.forEach((item) => {
        const tr = document.createElement('tr');
        tr.style.cursor = 'pointer';
        tr.addEventListener('click', () => openSearch(item.id));
        [item.query, item.location, item.resultsCount != null ? item.resultsCount : '—', item.status, formatDate(item.createdAt)].forEach((val, idx) => {
          const td = document.createElement('td');
          if (idx === 3) {
            const pill = document.createElement('span');
            pill.className = 'status-pill ' + esc(item.status);
            pill.textContent = esc(item.status);
            td.appendChild(pill);
          } else {
            td.textContent = val == null ? '—' : String(val);
          }
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
      box.appendChild(wrap);
    } catch (_) {
      box.textContent = 'Não foi possível carregar o dashboard.';
    }
  }

  async function loadSettings() {
    const nameEl = $('#settings-name');
    const emailEl = $('#settings-email');
    const verifiedEl = $('#settings-verified');
    const recoveryEmailEl = $('#reset-password-email');
    if (!currentUser) {
      try {
        const res = await api('/api/auth/me');
        if (res.ok && res.data && res.data.user) currentUser = res.data.user;
      } catch (_) {}
    }
    if (currentUser) {
      if (nameEl) nameEl.textContent = currentUser.name || '—';
      if (emailEl) emailEl.textContent = currentUser.email || '—';
      if (verifiedEl) verifiedEl.textContent = currentUser.emailVerified ? 'Verificado' : 'Não verificado';
      if (recoveryEmailEl) recoveryEmailEl.textContent = currentUser.email ? maskEmail(currentUser.email) : '—';
    } else if (recoveryEmailEl) {
      recoveryEmailEl.textContent = '—';
    }
  }

  function initNav() {
    $$('.nav-item').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const v = el.getAttribute('data-view');
        if (v && !el.disabled) showView(v);
      });
    });
  }

  function initMobileNav() {
    const toggle = $('#mobile-toggle');
    const overlay = $('#sidebar-overlay');
    if (toggle) {
      toggle.addEventListener('click', () => {
        const sidebar = $('#sidebar');
        if (sidebar && sidebar.classList.contains('open')) closeMobileSidebar();
        else openMobileSidebar();
      });
    }
    if (overlay) {
      overlay.addEventListener('click', closeMobileSidebar);
    }
  }

  let logoutInFlight = false;
  async function logout() {
    if (logoutInFlight) return;
    logoutInFlight = true;
    const btn = $('#btn-logout');
    if (btn) btn.disabled = true;
    try {
      const token = await ensureCsrf();
      const res = await api('/api/auth/logout', {
        method: 'POST',
        headers: { 'X-CSRF-Token': token },
        body: {},
      });
      if (!res.ok) {
        const msg = (res.data && res.data.error) || 'Não foi possível terminar a sessão.';
        showToast(msg, 'error');
        return;
      }
      currentUser = null;
      csrfToken = null;
      currentResults = [];
      currentResultsTotal = null;
      currentSearchMeta = null;
      setGuestUi();
      window.location.href = '/pages/login.html';
    } catch (_) {
      showToast('Erro de rede ao terminar a sessão.', 'error');
    } finally {
      logoutInFlight = false;
      if (btn) btn.disabled = false;
    }
  }

  function initLogout() {
    const btn = $('#btn-logout');
    if (btn) btn.addEventListener('click', (e) => {
      e.preventDefault();
      logout();
    });
  }

  function initSearchForm() {
    const form = $('#search-form');
    if (form) form.addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });
    const btn = $('#btn-search');
    if (btn) btn.addEventListener('click', (e) => { e.preventDefault(); runSearch(); });
    const saveBtn = $('#btn-save-leads');
    if (saveBtn) saveBtn.addEventListener('click', (e) => {
      e.preventDefault();
      saveSelectedLeads();
    });
    const saveAll = $('#btn-save-all-leads');
    if (saveAll) saveAll.addEventListener('click', (e) => {
      e.preventDefault();
      saveAllLeads();
    });
    const selAll = $('#results-select-all');
    if (selAll) selAll.addEventListener('change', () => {
      setResultsSelectAll(selAll.checked);
    });
  }

  function initBulkActions() {
    const leadsPage = $('#leads-select-page');
    if (leadsPage) {
      leadsPage.addEventListener('change', () => {
        $$('.lead-check').forEach((c) => {
          c.checked = leadsPage.checked;
          const id = String(c.value || '');
          if (!id) return;
          if (leadsPage.checked) selectedLeadIds.add(id);
          else selectedLeadIds.delete(id);
        });
        updateLeadsSelectionUi();
      });
    }
    const leadsDelSel = $('#leads-delete-selected');
    if (leadsDelSel) leadsDelSel.addEventListener('click', () => deleteSelectedLeads());
    const leadsDelAll = $('#leads-delete-all');
    if (leadsDelAll) leadsDelAll.addEventListener('click', () => deleteAllLeads());

    const histPage = $('#history-select-page');
    if (histPage) {
      histPage.addEventListener('change', () => {
        $$('.history-check').forEach((c) => {
          c.checked = histPage.checked;
          const id = String(c.value || '');
          if (!id) return;
          if (histPage.checked) selectedHistoryIds.add(id);
          else selectedHistoryIds.delete(id);
        });
        updateHistorySelectionUi();
      });
    }
    const histDelSel = $('#history-delete-selected');
    if (histDelSel) histDelSel.addEventListener('click', () => deleteSelectedSearches());
    const histDelAll = $('#history-delete-all');
    if (histDelAll) histDelAll.addEventListener('click', () => deleteAllSearches());

    const clearAct = $('#leads-btn-clear-activities');
    if (clearAct) clearAct.addEventListener('click', () => clearLeadActivities());
    const viewAct = $('#leads-btn-view-activities');
    if (viewAct) viewAct.addEventListener('click', () => openActivitiesFullView());
    const manageAppt = $('#leads-btn-manage-appointments');
    if (manageAppt) manageAppt.addEventListener('click', () => openAppointmentsFullView());
    const backAct = $('#leads-activities-full-back');
    if (backAct) backAct.addEventListener('click', () => {
      showLeadDetailOnly();
      loadLeadActivities();
      loadLeadAppointments();
    });
    const backAppt = $('#leads-appointments-full-back');
    if (backAppt) backAppt.addEventListener('click', () => {
      showLeadDetailOnly();
      loadLeadAppointments();
    });
    const addActFull = $('#leads-btn-add-activity-full');
    if (addActFull) addActFull.addEventListener('click', () => showActivityForm(true));
    const addApptFull = $('#leads-btn-add-appointment-full');
    if (addApptFull) addApptFull.addEventListener('click', () => showAppointmentForm(true));
    const fullQ = $('#leads-activities-full-q');
    if (fullQ) fullQ.addEventListener('input', () => { activitiesFullPage = 1; renderActivitiesFullPage(); });
    const fullType = $('#leads-activities-full-type');
    if (fullType) fullType.addEventListener('change', () => { activitiesFullPage = 1; renderActivitiesFullPage(); });

  }

  function initContactModal() {
    const closeBtn = $('#contact-modal-close');
    if (closeBtn) closeBtn.addEventListener('click', closeContactModal);
    const waBtn = $('#btn-open-whatsapp');
    if (waBtn) {
      waBtn.addEventListener('click', () => {
        const modal = $('#contact-modal');
        const msg = $('#contact-message');
        const digits = String((modal && modal.dataset.phone) || '').replace(/\D+/g, '');
        if (!digits) return;
        const text = (msg && msg.value) || '';
        window.open('https://wa.me/' + digits + '?text=' + encodeURIComponent(text), '_blank', 'noopener');
      });
    }
  }

  function initSettingsRecovery() {
    const showBtn = $('#btn-show-reset-password');
    const panel = $('#reset-password-panel');
    const cancelBtn = $('#btn-cancel-reset-password');
    const sendBtn = $('#btn-send-reset-link');
    if (showBtn && panel) showBtn.addEventListener('click', () => { panel.hidden = false; });
    if (cancelBtn && panel) cancelBtn.addEventListener('click', () => { panel.hidden = true; });
    if (sendBtn) {
      sendBtn.addEventListener('click', async () => {
        const ok = $('#reset-password-ok');
        const err = $('#reset-password-error');
        if (ok) { ok.hidden = true; ok.textContent = ''; }
        if (err) { err.hidden = true; err.textContent = ''; }
        try {
          if (!currentUser || !currentUser.email) {
            if (err) { err.hidden = false; err.textContent = 'Sessão inválida.'; }
            return;
          }
          const token = await ensureCsrf();
          const res = await api('/api/auth/forgot-password', {
            method: 'POST', headers: { 'X-CSRF-Token': token }, body: { email: currentUser.email },
          });
          const data = res.data || {};
          if (res.ok) {
            if (ok) {
              ok.hidden = false;
              ok.textContent = (data && data.message) || 'Se o email estiver associado a uma conta, enviámos instruções de recuperação.';
            }
          } else if (err) {
            err.hidden = false;
            err.textContent = (data && data.error) || 'Não foi possível enviar o pedido.';
          }
        } catch (_) {
          if (err) { err.hidden = false; err.textContent = 'Erro de rede.'; }
        }
      });
    }
  }

  function init() {
    initNav();
    initMobileNav();
    initLogout();
    initSearchForm();
    initContactModal();
    initSettingsRecovery();
    initConfirmModal();
    reparentLeadForms();
    initBulkActions();
    showView('dashboard');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init(); refreshAuthUi(); });
  } else {
    init();
    refreshAuthUi();
  }
})();
