(function () {
  'use strict';
  const titles = {
    dashboard: 'Dashboard',
    search: 'Nova pesquisa',
    results: 'Resultados',
    history: 'Histórico',
    leads: 'Leads guardados',
    settings: 'Configurações',
  };
  const PAGE_SIZE = 28;
  let currentResults = [];
  let currentSearchMeta = null;
  let csrfToken = null;
  let activePollTimer = null;
  let activeSearchId = null;
  let cancelRequested = false;
  let pendingCancel = false;
  let resultsPage = 1;
  let currentUser = null;
  let authState = 'loading';

  const $ = (s, r) => (r || document).querySelector(s);
  const $all = (s, r) => Array.from((r || document).querySelectorAll(s));
  function esc(s) { return s == null ? '' : String(s); }
  function displayOrNa(v) {
    if (v == null || String(v).trim() === '') return 'Não disponível';
    return String(v);
  }

  function maskEmail(email) {
    const value = String(email == null ? '' : email).trim();
    const at = value.indexOf('@');
    if (at <= 0 || at === value.length - 1) return '—';
    const local = value.slice(0, at);
    const domain = value.slice(at + 1);
    if (!domain) return '—';
    const visible = local.slice(0, Math.min(2, local.length));
    return visible + '****@' + domain;
  }

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

  function setStatus(msg, isError) {
    const el = $('#search-status');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = isError ? 'var(--color-coral-red)' : 'var(--color-fog)';
  }

  function stopPolling() {
    if (activePollTimer) { clearTimeout(activePollTimer); activePollTimer = null; }
  }

  function setProgress(visible, text) {
    const box = $('#results-progress');
    const t = $('#results-progress-text');
    if (box) box.hidden = !visible;
    if (t && text != null) t.textContent = text;
  }

  function setSummary(visible, text) {
    const box = $('#results-summary');
    const t = $('#results-summary-text');
    if (box) box.hidden = !visible;
    if (t && text != null) t.textContent = text;
  }

  function renderProviderStatus(providers) {
    let host = $('#provider-status-list');
    const progressBox = $('#results-progress');
    if (!host && progressBox) {
      host = document.createElement('div');
      host.id = 'provider-status-list';
      host.className = 'provider-status-list';
      progressBox.appendChild(host);
    }
    if (!host) return;
    host.innerHTML = '';
    if (!Array.isArray(providers) || !providers.length) return;
    const labels = { apify: 'Apify', tomtom: 'TomTom', foursquare: 'Foursquare' };
    const statusLabel = {
      ok: 'Concluído', empty: 'Sem resultados', error: 'Erro', failed: 'Erro',
      not_configured: 'Não configurado', cancelled: 'Cancelado', running: 'Em execução', pending: 'A aguardar',
    };
    providers.forEach((p) => {
      const code = p.code || p.provider || 'unknown';
      const st = (p.status || 'pending').toLowerCase();
      const chip = document.createElement('span');
      chip.className = 'provider-status-chip ' + st;
      const dot = document.createElement('span');
      dot.className = 'dot';
      chip.appendChild(dot);
      let label = (labels[code] || code) + ' — ' + (statusLabel[st] || st);
      if (typeof p.count === 'number' && (st === 'ok' || st === 'empty' || st === 'completed')) {
        label = (labels[code] || code) + ' — ' + p.count + ' resultados — ' + (statusLabel[st] || st);
      }
      chip.appendChild(document.createTextNode(label));
      host.appendChild(chip);
    });
  }

  function normalizePhoneForWa(phone) {
    if (!phone) return '';
    let p = String(phone).replace(/[^\d+]/g, '');
    if (p.startsWith('00')) p = '+' + p.slice(2);
    if (!p.startsWith('+') && p.length >= 9) p = '+' + p;
    return p;
  }

  function generateContactMessage(lead) {
    const name = (lead && lead.name) || 'empresa';
    const cat = (lead && lead.category) || '';
    const loc = (lead && lead.address) || '';
    let msg = 'Olá';
    if (name && name !== 'empresa') msg += ', ' + name;
    msg += '. Vi o vosso contacto';
    if (cat) msg += ' (' + cat + ')';
    if (loc) msg += ' em ' + loc;
    msg += ' e gostaria de saber mais sobre os vossos serviços. É possível falar um momento?';
    return msg;
  }

  function openContactModal(lead) {
    const modal = $('#contact-modal');
    if (!modal) return;
    const place = $('#contact-modal-place');
    const ta = $('#contact-message');
    if (place) place.textContent = (lead.name || 'Lead') + (lead.phone ? ' · ' + lead.phone : '');
    if (ta) ta.value = generateContactMessage(lead);
    modal.dataset.phone = lead.phone || '';
    modal.dataset.name = lead.name || '';
    modal.dataset.category = lead.category || '';
    modal.hidden = false;
  }

  function closeContactModal() {
    const modal = $('#contact-modal');
    if (modal) modal.hidden = true;
  }

  function openWhatsApp() {
    const modal = $('#contact-modal');
    const ta = $('#contact-message');
    if (!modal) return;
    const phone = normalizePhoneForWa(modal.dataset.phone || '');
    const text = (ta && ta.value) || '';
    if (!phone || phone.replace(/\D/g, '').length < 8) {
      setStatus('Sem número de telefone válido para WhatsApp.', true);
      return;
    }
    const url = 'https://wa.me/' + phone.replace(/\D/g, '') + '?text=' + encodeURIComponent(text);
    window.open(url, '_blank', 'noopener');
  }

  function totalPages() { return Math.max(1, Math.ceil(currentResults.length / PAGE_SIZE)); }

  function renderPagination() {
    const el = $('#results-pagination');
    if (!el) return;
    const total = currentResults.length;
    const pages = totalPages();
    if (total <= PAGE_SIZE) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.innerHTML = '';
    const prev = document.createElement('button');
    prev.type = 'button'; prev.className = 'btn btn-ghost btn-sm'; prev.textContent = 'Anterior';
    prev.disabled = resultsPage <= 1;
    prev.addEventListener('click', () => { if (resultsPage > 1) { resultsPage -= 1; renderResultsState(); } });
    const info = document.createElement('span');
    info.textContent = 'Página ' + resultsPage + ' / ' + pages + ' · ' + total + ' resultado' + (total === 1 ? '' : 's');
    const next = document.createElement('button');
    next.type = 'button'; next.className = 'btn btn-ghost btn-sm'; next.textContent = 'Seguinte';
    next.disabled = resultsPage >= pages;
    next.addEventListener('click', () => { if (resultsPage < pages) { resultsPage += 1; renderResultsState(); } });
    el.appendChild(prev); el.appendChild(info); el.appendChild(next);
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
      const photo = document.createElement('div');
      photo.className = 'result-card-photo';
      if (r.photoUrl || r.image) {
        const img = document.createElement('img');
        img.src = r.photoUrl || r.image; img.alt = ''; img.loading = 'lazy';
        photo.appendChild(img);
      } else {
        const ph = document.createElement('span');
        ph.className = 'photo-placeholder'; ph.textContent = 'Sem foto';
        photo.appendChild(ph);
      }
      card.appendChild(photo);
      const body = document.createElement('div');
      body.className = 'result-card-body';
      const name = document.createElement('div');
      name.className = 'result-card-name';
      name.textContent = esc(r.name || '—');
      body.appendChild(name);
      function line(text) {
        const d = document.createElement('div');
        d.className = 'result-card-line';
        d.textContent = esc(displayOrNa(text));
        return d;
      }
      body.appendChild(line(r.category));
      body.appendChild(line(r.address));
      body.appendChild(line(r.phone));
      body.appendChild(line(r.website));
      card.appendChild(body);
      const actions = document.createElement('div');
      actions.className = 'result-card-actions';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.className = 'result-check'; cb.value = r.id || '';
      cb.setAttribute('aria-label', 'Selecionar ' + (r.name || ''));
      actions.appendChild(cb);
      const contactBtn = document.createElement('button');
      contactBtn.type = 'button'; contactBtn.className = 'btn btn-primary btn-sm';
      contactBtn.textContent = 'Contactar';
      if (!r.phone) { contactBtn.disabled = true; contactBtn.title = 'Sem telefone'; }
      else contactBtn.addEventListener('click', () => openContactModal(r));
      actions.appendChild(contactBtn);
      if (r.website) {
        const web = document.createElement('a');
        web.className = 'btn btn-ghost btn-sm';
        web.href = r.website.startsWith('http') ? r.website : 'https://' + r.website;
        web.target = '_blank'; web.rel = 'noopener'; web.textContent = 'Site';
        actions.appendChild(web);
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
      await api('/api/searches/' + searchId + '/cancel', {
        method: 'POST', headers: { 'X-CSRF-Token': token }, body: {},
      });
    } catch (_) {}
  }

  async function cancelActiveSearch() {
    cancelRequested = true;
    pendingCancel = true;
    stopPolling();
    setStatus('A cancelar…');
    setProgress(true, 'Cancelamento solicitado…');
    if (activeSearchId) {
      await sendCancel(activeSearchId);
      currentResults = [];
      currentSearchMeta = { searchId: activeSearchId, status: 'cancelled', message: 'Pesquisa cancelada. Nenhum resultado foi guardado.' };
      setStatus('Pesquisa cancelada.', false);
      setProgress(false);
      setSummary(true, 'Pesquisa cancelada. Nenhum resultado foi persistido.');
      renderResultsState();
      activeSearchId = null;
      pendingCancel = false;
      resetSearchUiButtons();
      return;
    }
    setStatus('Cancelamento pendente…');
  }

  async function pollStatus(searchId) {
    if (cancelRequested || searchId !== activeSearchId) return;
    try {
      const { res, data } = await api('/api/searches/' + searchId + '/status');
      if (!res.ok) {
        setProgress(false);
        setStatus('Não foi possível obter o estado da pesquisa.', true);
        stopPolling();
        resetSearchUiButtons();
        return;
      }
      const status = data.status || '';
      if (Array.isArray(data.providers) && data.providers.length) renderProviderStatus(data.providers);
      setProgress(true, data.message || data.progress || ('Estado: ' + status));
      if (status === 'running' || status === 'pending' || status === 'queued') {
        activePollTimer = setTimeout(() => pollStatus(searchId), 1500);
        return;
      }
      stopPolling();
      setProgress(false);
      if (status === 'cancelled') {
        currentResults = [];
        currentSearchMeta = { searchId, status: 'cancelled', message: 'Pesquisa cancelada. Nenhum resultado foi guardado.' };
        setStatus('Pesquisa cancelada.', false);
        setSummary(true, 'Pesquisa cancelada pelo utilizador. Nenhum resultado foi persistido.');
        if (Array.isArray(data.providers)) renderProviderStatus(data.providers);
        renderResultsState();
        resetSearchUiButtons();
        activeSearchId = null;
        return;
      }
      if (status === 'failed' || status === 'error') {
        currentResults = [];
        currentSearchMeta = { searchId, status, message: data.errorSummary || data.message || 'A pesquisa falhou.' };
        setStatus(data.errorSummary || data.message || 'A pesquisa falhou.', true);
        setSummary(true, data.errorSummary || data.message || 'A pesquisa falhou.');
        if (Array.isArray(data.providers)) renderProviderStatus(data.providers);
        renderResultsState();
        resetSearchUiButtons();
        activeSearchId = null;
        return;
      }
      const { res: r2, data: d2 } = await api('/api/searches/' + searchId + '/results');
      if (!r2.ok) { setStatus('Não foi possível carregar os resultados.', true); resetSearchUiButtons(); return; }
      currentResults = d2.results || [];
      resultsPage = 1;
      currentSearchMeta = { searchId, status: (d2.search && d2.search.status) || status, message: d2.message || '', outcome: currentResults.length ? 'results' : 'empty' };
      if (Array.isArray(d2.providers)) renderProviderStatus(d2.providers);
      else if (Array.isArray(data.providers)) renderProviderStatus(data.providers);
      const msg = currentResults.length ? currentResults.length + ' resultado(s) encontrados.' : (d2.message || 'Nenhum resultado encontrado.');
      setStatus(msg, false);
      setSummary(true, msg);
      renderResultsState();
      resetSearchUiButtons();
      activeSearchId = null;
    } catch (_) {
      if (!cancelRequested) setStatus('Erro de rede ao consultar o estado.', true);
      stopPolling();
      setProgress(false);
      resetSearchUiButtons();
    }
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
    stopPolling();
    cancelRequested = false;
    pendingCancel = false;
    activeSearchId = null;
    currentResults = [];
    resultsPage = 1;
    currentSearchMeta = null;
    setSummary(false, '');
    setProgress(false);
    renderProviderStatus([]);
    const btn = $('#btn-search');
    if (btn) { btn.disabled = true; btn.textContent = 'A iniciar…'; }
    let cancelBtn = $('#btn-cancel-search');
    if (!cancelBtn) {
      cancelBtn = document.createElement('button');
      cancelBtn.type = 'button'; cancelBtn.id = 'btn-cancel-search';
      cancelBtn.className = 'btn btn-ghost'; cancelBtn.textContent = 'Cancelar';
      cancelBtn.addEventListener('click', cancelActiveSearch);
      const toolbarLeft = btn && btn.parentElement;
      if (toolbarLeft) toolbarLeft.appendChild(cancelBtn);
    }
    cancelBtn.hidden = false;
    setStatus('A iniciar pesquisa…');
    navigate('results');
    setProgress(true, 'A iniciar pesquisa nos fornecedores…');
    renderProviderStatus([
      { code: 'apify', status: 'pending' },
      { code: 'tomtom', status: 'pending' },
      { code: 'foursquare', status: 'pending' },
    ]);
    try {
      const token = await ensureCsrf();
      const { res, data } = await api('/api/searches', {
        method: 'POST',
        headers: { 'X-CSRF-Token': token },
        body: {
          query: String(query).trim(), location: String(location).trim(), limit,
          minRating: minRating || null, hasPhone, hasEmail, noWebsite, minReviews,
        },
      });
      if (res.status === 401) { setStatus('Inicia sessão para pesquisar.', true); setProgress(false); resetSearchUiButtons(); return; }
      if (res.status === 403 && data && data.code === 'EMAIL_NOT_VERIFIED') { setStatus('Verifica o teu email antes de pesquisar.', true); setProgress(false); resetSearchUiButtons(); return; }
      if (res.status === 402 || (data && data.code === 'QUOTA')) { setStatus((data && data.error) || 'Quota esgotada.', true); setProgress(false); resetSearchUiButtons(); return; }
      if (!res.ok) { setStatus((data && data.error) || 'Falha na pesquisa.', true); setProgress(false); resetSearchUiButtons(); return; }
      const searchId = data.searchId || data.id;
      if (!searchId) { setStatus('Resposta inválida do servidor.', true); setProgress(false); resetSearchUiButtons(); return; }
      if (pendingCancel || cancelRequested) {
        await sendCancel(searchId);
        currentResults = [];
        currentSearchMeta = { searchId, status: 'cancelled', message: 'Pesquisa cancelada. Nenhum resultado foi guardado.' };
        setStatus('Pesquisa cancelada.', false);
        setProgress(false);
        setSummary(true, 'Pesquisa cancelada. Nenhum resultado foi persistido.');
        renderResultsState();
        activeSearchId = null;
        pendingCancel = false;
        resetSearchUiButtons();
        return;
      }
      activeSearchId = searchId;
      currentSearchMeta = { searchId, status: data.status || 'running' };
      setStatus('Pesquisa em curso…');
      setProgress(true, data.message || 'A recolher dados de múltiplos fornecedores…');
      if (btn) btn.textContent = 'A pesquisar…';
      if (data.status === 'completed' || data.results) {
        currentResults = data.results || [];
        resultsPage = 1;
        currentSearchMeta = { searchId, status: 'completed', message: data.message || '', outcome: currentResults.length ? 'results' : 'empty' };
        setProgress(false);
        const msg = currentResults.length ? currentResults.length + ' resultado(s).' : (data.message || 'Nenhum resultado.');
        setStatus(msg, false);
        setSummary(true, msg);
        renderResultsState();
        resetSearchUiButtons();
        activeSearchId = null;
        return;
      }
      pollStatus(searchId);
    } catch (_) {
      setStatus('Não foi possível realizar a pesquisa. Tenta novamente.', true);
      setProgress(false);
      resetSearchUiButtons();
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
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap table-wrap-dashboard';
    const table = document.createElement('table');
    table.className = 'data table-dashboard';
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
    table.appendChild(tbody);
    wrap.appendChild(table);
    box.appendChild(wrap);
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
    resultsPage = 1;
    currentSearchMeta = { searchId: id, status: data.search && data.search.status };
    if (Array.isArray(data.providers)) renderProviderStatus(data.providers);
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

  function setAuthState(state) {
    authState = state;
    const actions = document.querySelector('.topbar-actions');
    if (actions) actions.setAttribute('data-auth-state', state);
  }
  function setGuestUi() {
    currentUser = null; setAuthState('guest');
    const guest = document.getElementById('guest-actions');
    const user = document.getElementById('user-actions');
    if (guest) guest.hidden = false;
    if (user) user.hidden = true;
    const badge = document.getElementById('auth-badge');
    if (badge) { badge.textContent = ''; badge.removeAttribute('title'); }
  }
  function setAuthedUi(user) {
    currentUser = user; setAuthState('authenticated');
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
          await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': token, 'Content-Type': 'application/json' }, body: '{}' });
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
      if (res.status === 401) { setGuestUi(); return; }
      if (!res.ok) { setAuthErrorUi(); return; }
      const data = await res.json();
      if (data && data.user) setAuthedUi(data.user); else setGuestUi();
    } catch (_) { setAuthErrorUi(); }
  }
  function loadSettings() {
    const nameEl = document.getElementById('settings-name');
    const emailEl = document.getElementById('settings-email');
    const verEl = document.getElementById('settings-verified');
    if (!currentUser) {
      if (nameEl) nameEl.textContent = '—';
      if (emailEl) emailEl.textContent = '—';
      if (verEl) verEl.textContent = authState === 'error' ? 'Não foi possível verificar a sessão.' : 'Inicie sessão para ver os dados da conta.';
      return;
    }
    if (nameEl) nameEl.textContent = currentUser.name || '—';
    if (emailEl) emailEl.textContent = currentUser.email || '—';
    if (verEl) verEl.textContent = currentUser.emailVerified ? 'Confirmado' : 'Por confirmar';
  }
  function initPasswordResetRequest() {
    const showBtn = document.getElementById('btn-show-reset-password');
    const panel = document.getElementById('reset-password-panel');
    const cancelBtn = document.getElementById('btn-cancel-reset-password');
    const sendBtn = document.getElementById('btn-send-reset-link');
    const err = document.getElementById('reset-password-error');
    const ok = document.getElementById('reset-password-ok');
    const emailEl = document.getElementById('reset-password-email');
    function hideMessages() {
      if (err) { err.classList.remove('visible'); err.textContent = ''; }
      if (ok) { ok.classList.remove('visible'); ok.textContent = ''; }
    }
    if (showBtn && panel) {
      showBtn.addEventListener('click', () => {
        panel.hidden = false; showBtn.hidden = true; hideMessages();
        if (emailEl) emailEl.textContent = (currentUser && currentUser.email) ? maskEmail(currentUser.email) : '—';
      });
    }
    if (cancelBtn && panel && showBtn) {
      cancelBtn.addEventListener('click', () => { panel.hidden = true; showBtn.hidden = false; hideMessages(); });
    }
    if (sendBtn) {
      sendBtn.addEventListener('click', async () => {
        hideMessages();
        if (!currentUser || !currentUser.email) {
          if (err) { err.textContent = 'Inicie sessão para solicitar a recuperação.'; err.classList.add('visible'); }
          return;
        }
        sendBtn.disabled = true; sendBtn.textContent = 'A enviar…';
        try {
          const token = await ensureCsrf();
          const { res, data } = await api('/api/auth/forgot-password', {
            method: 'POST', headers: { 'X-CSRF-Token': token }, body: { email: currentUser.email },
          });
          if (!res.ok) {
            if (err) { err.textContent = (data && data.error) || 'Não foi possível enviar o pedido.'; err.classList.add('visible'); }
            return;
          }
          if (ok) {
            ok.textContent = (data && data.message) || 'Se o email estiver associado a uma conta, enviámos instruções de recuperação.';
            ok.classList.add('visible');
          }
        } catch (_) {
          if (err) { err.textContent = 'Erro de rede. Tenta novamente.'; err.classList.add('visible'); }
        } finally {
          sendBtn.disabled = false; sendBtn.textContent = 'Enviar link de recuperação';
        }
      });
    }
  }

  function init() {
    const form = $('#search-form');
    if (form) form.addEventListener('submit', submitSearch);
    $all('.nav-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const view = btn.getAttribute('data-view');
        if (view && !btn.disabled) navigate(view);
      });
    });
    const mobileToggle = $('#mobile-toggle');
    const sidebar = $('#sidebar');
    const overlay = $('#sidebar-overlay');
    if (mobileToggle && sidebar) {
      mobileToggle.addEventListener('click', () => {
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
    const selectAll = $('#select-all');
    if (selectAll) {
      selectAll.addEventListener('change', () => {
        $all('.result-check').forEach((c) => { c.checked = selectAll.checked; });
      });
    }
    const saveBtn = $('#btn-save-leads');
    if (saveBtn) saveBtn.addEventListener('click', saveSelectedLeads);
    $all('[data-close-modal]').forEach((el) => { el.addEventListener('click', closeContactModal); });
    const btnWa = $('#btn-open-whatsapp');
    if (btnWa) btnWa.addEventListener('click', openWhatsApp);
    const btnRegen = $('#btn-regen-message');
    if (btnRegen) {
      btnRegen.addEventListener('click', () => {
        const modal = $('#contact-modal');
        const ta = $('#contact-message');
        if (!modal || !ta) return;
        ta.value = generateContactMessage({ name: modal.dataset.name, category: modal.dataset.category, phone: modal.dataset.phone });
      });
    }
    initPasswordResetRequest();
    const hash = (location.hash || '#dashboard').replace('#', '');
    navigate(titles[hash] ? hash : 'dashboard');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init(); refreshAuthUi(); });
  } else {
    init();
    refreshAuthUi();
  }
})();
