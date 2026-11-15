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
  let csrfToken = null;
  let currentUser = null;
  let currentResults = [];
  let currentSearchMeta = null;
  let resultsPage = 1;
  let activeSearchId = null;
  let pollTimer = null;
  let abortRequested = false;

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

  /** Toast notifications for save feedback (success / warn / error). */
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

  function isGooglePlaceId(id) {
    if (!id || typeof id !== 'string') return false;
    return /^ChIJ[A-Za-z0-9_-]{10,}$/.test(id.trim());
  }

  /**
   * Build a Maps URL for THIS card only.
   * Priority: 1) Google Place ID  2) name + address  3) coordinates.
   * Never treats TomTom/Foursquare IDs as Google Place IDs.
   */
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

  function showView(view) {
    $$('.view').forEach((el) => el.classList.toggle('active', el.id === 'view-' + view));
    $$('.nav-item').forEach((el) => el.classList.toggle('active', el.getAttribute('data-view') === view));
    const t = $('#topbar-title');
    if (t) t.textContent = titles[view] || 'Maps Leads Finder';
    if (view === 'results') renderResultsState();
    if (view === 'dashboard') loadDashboard();
    if (view === 'history') loadHistory();
    if (view === 'leads') loadLeads();
    if (view === 'settings') loadSettings();
  }

  function setGuestUi() {
    const guest = $('#guest-actions'); const user = $('#user-actions');
    if (guest) guest.hidden = false; if (user) user.hidden = true;
  }
  function setAuthedUi() {
    const guest = $('#guest-actions'); const user = $('#user-actions');
    if (guest) guest.hidden = true; if (user) user.hidden = false;
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
    prev.addEventListener('click', () => { if (resultsPage > 1) { resultsPage -= 1; renderResultsState(); } });
    const next = document.createElement('button');
    next.type = 'button'; next.className = 'btn btn-ghost btn-sm'; next.textContent = 'Seguinte';
    next.disabled = resultsPage >= pages;
    next.addEventListener('click', () => { if (resultsPage < pages) { resultsPage += 1; renderResultsState(); } });
    el.appendChild(prev); el.appendChild(next);
  }

  function renderResultsState() {
    const grid = $('#results-cards');
    const empty = $('#results-empty');
    const count = $('#results-count');
    if (!grid) return;
    grid.innerHTML = '';
    if (!currentResults.length) {
      if (empty) {
        empty.hidden = false;
        const msg = (currentSearchMeta && currentSearchMeta.message) || 'Sem resultados para mostrar.';
        const h = empty.querySelector('h3'); const p = empty.querySelector('p');
        if (h) h.textContent = 'Sem resultados';
        if (p) p.textContent = msg;
      }
      if (count) count.textContent = '0 resultados';
      renderPagination();
      return;
    }
    if (empty) empty.hidden = true;
    if (count) count.textContent = currentResults.length + ' resultado' + (currentResults.length === 1 ? '' : 's');
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
        setStatus('Erro de rede ao consultar o estado da pesquisa.', true);
        setProgress(false);
        setSummary(true, 'Erro de rede. Tenta novamente.');
        stopPolling(); resetSearchUiButtons(); activeSearchId = null;
        return;
      }
      if (!statusRes.ok) {
        const msg = (statusRes.data && statusRes.data.error) ||
          (statusRes.status === 404 ? 'Pesquisa não encontrada.' : 'Não foi possível obter o estado da pesquisa.');
        setStatus(msg, true); setProgress(false); setSummary(true, msg);
        currentResults = []; currentSearchMeta = { message: msg };
        renderResultsState(); stopPolling(); resetSearchUiButtons(); activeSearchId = null;
        return;
      }
      const data = statusRes.data || {};
      const status = data.status || '';
      const providers = data.providers || [];
      if (Array.isArray(providers) && providers.length) {
        setProgress(true, providers.map((p) => (p.code || '') + ': ' + (p.status || '')).join(' · '));
      } else {
        setProgress(true, data.message || ('Estado: ' + status));
      }
      if (status === 'running' || status === 'pending' || status === 'queued') {
        await new Promise((r) => { pollTimer = setTimeout(r, 1500); });
        continue;
      }
      stopPolling(); setProgress(false);
      if (status === 'cancelled') {
        currentResults = [];
        currentSearchMeta = { searchId, status: 'cancelled', message: 'Pesquisa cancelada.' };
        setStatus('Pesquisa cancelada.'); setSummary(true, 'Pesquisa cancelada pelo utilizador.');
        renderResultsState(); resetSearchUiButtons(); activeSearchId = null;
        return;
      }
      if (status === 'failed' || status === 'error') {
        const errMsg = data.errorSummary || data.message || 'A pesquisa falhou.';
        currentResults = []; currentSearchMeta = { searchId, status, message: errMsg };
        setStatus(errMsg, true); setSummary(true, errMsg);
        renderResultsState(); resetSearchUiButtons(); activeSearchId = null;
        return;
      }
      let resultsRes;
      try {
        resultsRes = await api('/api/searches/' + searchId + '/results');
      } catch (_) {
        setStatus('Erro de rede ao carregar resultados.', true);
        setSummary(true, 'Erro de rede ao carregar resultados.');
        resetSearchUiButtons(); activeSearchId = null;
        return;
      }
      if (!resultsRes.ok) {
        const msg = (resultsRes.data && resultsRes.data.error) || 'Não foi possível carregar os resultados.';
        setStatus(msg, true); setSummary(true, msg);
        currentResults = []; currentSearchMeta = { message: msg };
        renderResultsState(); resetSearchUiButtons(); activeSearchId = null;
        return;
      }
      const d2 = resultsRes.data || {};
      currentResults = Array.isArray(d2.results) ? d2.results : [];
      resultsPage = 1;
      currentSearchMeta = { searchId, status: (d2.search && d2.search.status) || status, message: d2.message || '' };
      const msg = currentResults.length
        ? currentResults.length + ' resultado(s) encontrados.'
        : (d2.message || 'Nenhum resultado encontrado.');
      setStatus(currentResults.length ? '' : msg, !currentResults.length);
      setSummary(true, msg);
      renderResultsState();
      resetSearchUiButtons();
      activeSearchId = null;
      return;
    }
    stopPolling(); resetSearchUiButtons(); activeSearchId = null;
  }

  async function runSearch() {
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
    stopPolling(); abortRequested = false;
    currentResults = []; resultsPage = 1; currentSearchMeta = null; setSummary(false, '');
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
        abortRequested = true; stopPolling();
        if (activeSearchId) await sendCancel(activeSearchId);
        setStatus('Pesquisa cancelada.'); setProgress(false); setSummary(true, 'Pesquisa cancelada.');
        currentResults = []; currentSearchMeta = { message: 'Pesquisa cancelada.' };
        renderResultsState(); resetSearchUiButtons(); activeSearchId = null;
      };
    }
    setProgress(true, 'A iniciar pesquisa…'); setStatus(''); showView('results');
    try {
      const token = await ensureCsrf();
      const res = await api('/api/searches', {
        method: 'POST',
        headers: { 'X-CSRF-Token': token },
        body: {
          query, location, limit,
          minRating: minRating || null,
          hasPhone, hasEmail, noWebsite, minReviews,
        },
      });
      if (!res.ok) {
        const data = res.data || {};
        if (res.status === 403 && data && data.code === 'EMAIL_NOT_VERIFIED') {
          setStatus('Verifica o teu email antes de pesquisar.', true);
          setProgress(false); resetSearchUiButtons(); return;
        }
        setStatus((data && data.error) || 'Falha ao iniciar pesquisa.', true);
        setProgress(false); resetSearchUiButtons(); return;
      }
      const searchId = res.data && (res.data.searchId || res.data.id);
      activeSearchId = searchId;
      if (!searchId) {
        setStatus('Resposta inválida do servidor.', true);
        setProgress(false); resetSearchUiButtons(); return;
      }
      await pollSearchUntilDone(searchId);
    } catch (err) {
      setStatus('Erro de rede ao pesquisar.', true);
      setProgress(false);
      resetSearchUiButtons();
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

  async function openSearch(id) {
    showView('results');
    setProgress(true, 'A carregar resultados…');
    try {
      const res = await api('/api/searches/' + id + '/results');
      if (!res.ok) {
        const msg = (res.data && res.data.error) ||
          (res.status === 404 ? 'Pesquisa não encontrada.' : 'Não foi possível carregar a pesquisa.');
        setStatus(msg, true);
        setSummary(true, msg);
        currentResults = [];
        currentSearchMeta = { message: msg };
        renderResultsState();
        setProgress(false);
        return;
      }
      currentResults = Array.isArray(res.data.results) ? res.data.results : [];
      currentSearchMeta = res.data;
      resultsPage = 1;
      renderResultsState();
      setProgress(false);
      setSummary(true, currentResults.length
        ? currentResults.length + ' resultado(s).'
        : 'Sem resultados nesta pesquisa.');
    } catch (_) {
      setStatus('Erro de rede.', true);
      setSummary(true, 'Erro de rede ao carregar a pesquisa.');
      setProgress(false);
    }
  }

  async function loadHistory() {
    const body = $('#history-body');
    if (!body) return;
    body.innerHTML = '';
    try {
      const res = await api('/api/searches?limit=50');
      if (!res.ok) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 5;
        td.textContent = res.status === 401 ? 'Inicia sessão para ver o histórico.' : 'Não foi possível carregar o histórico.';
        tr.appendChild(td);
        body.appendChild(tr);
        return;
      }
      const items = (res.data && res.data.items) || [];
      if (!items.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 5;
        td.textContent = 'Ainda não há pesquisas.';
        tr.appendChild(td);
        body.appendChild(tr);
        return;
      }
      items.forEach((item) => {
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
        body.appendChild(tr);
      });
    } catch (_) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.textContent = 'Não foi possível carregar o histórico.';
      tr.appendChild(td);
      body.appendChild(tr);
    }
  }

  async function loadLeads() {
    const body = $('#leads-body');
    if (!body) return;
    body.innerHTML = '';
    try {
      const res = await api('/api/searches/leads/saved');
      if (!res.ok) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 5;
        td.textContent = res.status === 401 ? 'Inicia sessão para ver os leads.' : 'Não foi possível carregar os leads.';
        tr.appendChild(td);
        body.appendChild(tr);
        return;
      }
      const items = (res.data && res.data.items) || [];
      if (!items.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 5;
        td.textContent = 'Ainda não há leads guardados.';
        tr.appendChild(td);
        body.appendChild(tr);
        return;
      }
      items.forEach((item) => {
        const tr = document.createElement('tr');
        [item.name, item.address, item.phone, item.email, formatDate(item.createdAt)].forEach((val) => {
          const td = document.createElement('td');
          td.textContent = val == null || val === '' ? '—' : String(val);
          tr.appendChild(td);
        });
        body.appendChild(tr);
      });
    } catch (_) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.textContent = 'Não foi possível carregar os leads.';
      tr.appendChild(td);
      body.appendChild(tr);
    }
  }

  async function loadSettings() {
    const nameEl = $('#settings-name');
    const emailEl = $('#settings-email');
    const verifiedEl = $('#settings-verified');
    if (!currentUser) {
      try {
        const res = await api('/api/auth/me');
        if (res.ok && res.data && res.data.user) currentUser = res.data.user;
      } catch (_) {}
    }
    if (nameEl) nameEl.textContent = (currentUser && currentUser.name) || '—';
    if (emailEl) emailEl.textContent = (currentUser && currentUser.email) || '—';
    if (verifiedEl) {
      verifiedEl.textContent = currentUser
        ? (currentUser.emailVerified ? 'Verificado' : 'Por verificar')
        : '—';
    }
    const resetEmail = $('#reset-password-email');
    if (resetEmail) resetEmail.textContent = currentUser && currentUser.email ? maskEmail(currentUser.email) : '—';
  }

  let saveInFlight = false;
  async function saveSelectedLeads() {
    if (saveInFlight) return;
    const ids = $$('.result-check:checked').map((c) => c.value).filter(Boolean);
    if (!ids.length) {
      showToast('Seleciona pelo menos um estabelecimento para guardar.', 'warn');
      return;
    }
    const saveBtn = $('#btn-save-leads');
    saveInFlight = true;
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'A guardar…'; }
    try {
      const token = await ensureCsrf();
      const res = await api('/api/searches/leads/save', {
        method: 'POST', headers: { 'X-CSRF-Token': token }, body: { resultIds: ids },
      });
      if (!res.ok) {
        showToast('Não foi possível guardar os estabelecimentos. Tenta novamente.', 'error');
        return;
      }
      const data = res.data || {};
      const savedCount = data.savedCount != null ? data.savedCount : ((data.saved && data.saved.length) || 0);
      const already = data.alreadySavedCount != null ? data.alreadySavedCount : 0;
      if (savedCount > 0 && already > 0) {
        showToast(savedCount + ' estabelecimento' + (savedCount === 1 ? '' : 's') +
          ' guardado' + (savedCount === 1 ? '' : 's') + '. ' + already +
          ' já estava' + (already === 1 ? '' : 'm') + ' guardado' + (already === 1 ? '' : 's') + '.', 'success');
      } else if (savedCount > 0) {
        showToast(savedCount === 1
          ? 'Estabelecimento guardado com sucesso.'
          : savedCount + ' estabelecimentos guardados com sucesso.', 'success');
      } else if (already > 0) {
        showToast(already === 1
          ? 'Este estabelecimento já está guardado.'
          : already + ' estabelecimentos já estavam guardados.', 'warn');
      } else {
        showToast('Nenhum estabelecimento foi guardado.', 'warn');
      }
    } catch (_) {
      showToast('Não foi possível guardar os estabelecimentos. Tenta novamente.', 'error');
    } finally {
      saveInFlight = false;
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Guardar selecionados'; }
    }
  }

  function initNav() {
    $$('.nav-item').forEach((el) => {
      el.addEventListener('click', () => {
        const v = el.getAttribute('data-view');
        if (v && !el.disabled) showView(v);
      });
    });
    const toggle = $('#mobile-toggle'); const sidebar = $('#sidebar'); const overlay = $('#sidebar-overlay');
    if (toggle && sidebar) {
      toggle.addEventListener('click', () => {
        sidebar.classList.toggle('open');
        if (overlay) {
          overlay.classList.toggle('open');
          overlay.setAttribute('aria-hidden', sidebar.classList.contains('open') ? 'false' : 'true');
        }
      });
    }
    if (overlay) {
      overlay.addEventListener('click', () => {
        if (sidebar) sidebar.classList.remove('open');
        overlay.classList.remove('open');
        overlay.setAttribute('aria-hidden', 'true');
      });
    }
    const logout = $('#btn-logout');
    if (logout) {
      logout.addEventListener('click', async () => {
        try {
          const token = await ensureCsrf();
          await api('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': token }, body: {} });
        } catch (_) {}
        currentUser = null; setGuestUi(); showView('dashboard');
      });
    }
  }

  function initSearchForm() {
    const form = $('#search-form');
    if (form) form.addEventListener('submit', (ev) => { ev.preventDefault(); runSearch(); });
    const btn = $('#btn-search');
    if (btn) btn.addEventListener('click', (ev) => { ev.preventDefault(); runSearch(); });
    const saveBtn = $('#btn-save-leads');
    if (saveBtn) saveBtn.addEventListener('click', saveSelectedLeads);
  }

  function initContactModal() {
    $$('[data-close-modal]').forEach((el) => el.addEventListener('click', closeContactModal));
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
    initSearchForm();
    initContactModal();
    initSettingsRecovery();
    showView('dashboard');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init(); refreshAuthUi(); });
  } else {
    init();
    refreshAuthUi();
  }
})();
