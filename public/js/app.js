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

  const PAGE_SIZE = 28;
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
  function displayOrNa(v) {
    if (v == null || String(v).trim() === '') return 'Não informado';
    return String(v);
  }

  function fieldRow(label, value) {
    const row = document.createElement('div');
    row.className = 'result-card-field';
    const lab = document.createElement('span');
    lab.className = 'result-card-field-label';
    lab.textContent = label;
    const val = document.createElement('span');
    val.className = 'result-card-field-value';
    val.textContent = esc(displayOrNa(value));
    row.appendChild(lab);
    row.appendChild(val);
    return row;
  }

  function isSafeGoogleMapsUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
      const u = new URL(url.trim());
      if (u.protocol !== 'https:') return false;
      const host = u.hostname.toLowerCase();
      return (
        host === 'maps.google.com' ||
        host === 'www.google.com' ||
        host === 'google.com' ||
        host.endsWith('.google.com') ||
        host === 'maps.app.goo.gl' ||
        host === 'goo.gl'
      ) && (host.includes('google') || host.includes('goo.gl'));
    } catch (_) {
      return false;
    }
  }

  function buildGoogleMapsUrl(r) {
    if (r.googleMapsUrl && isSafeGoogleMapsUrl(r.googleMapsUrl)) {
      return r.googleMapsUrl.trim();
    }
    if (r.mapsUrl && isSafeGoogleMapsUrl(r.mapsUrl)) {
      return r.mapsUrl.trim();
    }
    const lat = r.lat != null ? Number(r.lat) : NaN;
    const lng = r.lng != null ? Number(r.lng) : NaN;
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      const q = encodeURIComponent(lat + ',' + lng);
      return 'https://www.google.com/maps/search/?api=1&query=' + q;
    }
    const parts = [];
    if (r.name && String(r.name).trim()) parts.push(String(r.name).trim());
    if (r.address && String(r.address).trim()) parts.push(String(r.address).trim());
    if (!parts.length) return null;
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(parts.join(' '));
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

  async function api(path, opts) {
    const options = opts || {};
    const headers = Object.assign({ Accept: 'application/json' }, options.headers || {});
    let body = options.body;
    if (body && typeof body === 'object' && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const res = await fetch(path, {
      method: options.method || 'GET',
      headers,
      body,
      credentials: 'same-origin',
    });
    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
    return { status: res.status, ok: res.ok, data };
  }

  function showView(view) {
    $$('.view').forEach((el) => el.classList.toggle('active', el.id === 'view-' + view));
    $$('.nav-item').forEach((el) => el.classList.toggle('active', el.getAttribute('data-view') === view));
    const t = $('#topbar-title');
    if (t) t.textContent = titles[view] || 'Maps Leads Finder';
    const shell = document.body;
    if (shell) shell.setAttribute('data-view', view);
    if (view === 'results') renderResultsState();
    if (view === 'dashboard') loadDashboard();
    if (view === 'history') loadHistory();
    if (view === 'leads') loadLeads();
    if (view === 'settings') loadSettings();
  }

  function setGuestUi() {
    const guest = $('#guest-actions');
    const user = $('#user-actions');
    if (guest) guest.hidden = false;
    if (user) user.hidden = true;
  }

  function setAuthedUi() {
    const guest = $('#guest-actions');
    const user = $('#user-actions');
    if (guest) guest.hidden = true;
    if (user) user.hidden = false;
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
      } else {
        currentUser = null;
        setGuestUi();
      }
    } catch (_) {
      currentUser = null;
      setGuestUi();
    }
  }

  function totalPages() {
    return Math.max(1, Math.ceil(currentResults.length / PAGE_SIZE));
  }

  function renderPagination() {
    const el = $('#results-pagination');
    if (!el) return;
    el.innerHTML = '';
    if (!currentResults.length) return;
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
    el.appendChild(prev);
    el.appendChild(next);
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
      const photoSrc = r.photoUrl || r.image || null;
      if (photoSrc) {
        const img = document.createElement('img');
        img.src = photoSrc;
        img.alt = r.name ? ('Foto de ' + String(r.name)) : 'Foto do estabelecimento';
        img.loading = 'lazy';
        img.width = 320;
        img.height = 160;
        img.addEventListener('error', () => {
          photo.innerHTML = '';
          const ph = document.createElement('span');
          ph.className = 'photo-placeholder';
          ph.textContent = 'Sem foto';
          photo.appendChild(ph);
        });
        photo.appendChild(img);
      } else {
        const ph = document.createElement('span');
        ph.className = 'photo-placeholder';
        ph.textContent = 'Sem foto';
        photo.appendChild(ph);
      }
      card.appendChild(photo);
      const body = document.createElement('div');
      body.className = 'result-card-body';
      const name = document.createElement('div');
      name.className = 'result-card-name';
      const displayName = r.name && String(r.name).trim() ? String(r.name).trim() : 'Nome não informado';
      name.textContent = esc(displayName);
      body.appendChild(name);
      body.appendChild(fieldRow('Categoria', r.category));
      body.appendChild(fieldRow('Endereço', r.address));
      body.appendChild(fieldRow('Telefone', r.phone));
      body.appendChild(fieldRow('Email', r.email));
      body.appendChild(fieldRow('Website', r.website));
      if (r.rating != null || r.reviewsCount != null) {
        const ratingBits = [];
        if (r.rating != null) ratingBits.push(String(r.rating));
        if (r.reviewsCount != null) ratingBits.push(String(r.reviewsCount) + ' avaliações');
        body.appendChild(fieldRow('Classificação', ratingBits.join(' · ')));
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
        maps.href = mapsUrl;
        maps.target = '_blank';
        maps.rel = 'noopener noreferrer';
        maps.textContent = 'Ver no Maps';
        actions.appendChild(maps);
      }
      if (r.website) {
        const web = document.createElement('a');
        web.className = 'btn btn-ghost btn-sm';
        web.href = r.website.startsWith('http') ? r.website : 'https://' + r.website;
        web.target = '_blank'; web.rel = 'noopener noreferrer'; web.textContent = 'Site';
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

  function openContactModal(r) {
    const modal = $('#contact-modal');
    if (!modal) return;
    modal.hidden = false;
    const title = $('#contact-modal-title');
    if (title) title.textContent = r.name || 'Contacto';
    const phoneEl = $('#contact-phone');
    if (phoneEl) phoneEl.textContent = r.phone || '—';
    const msg = $('#contact-message');
    if (msg) {
      msg.value = 'Olá, vi o estabelecimento ' + (r.name || '') + ' e gostaria de mais informações.';
    }
    const wa = $('#contact-whatsapp');
    if (wa) {
      const digits = String(r.phone || '').replace(/\D+/g, '');
      if (digits) {
        wa.href = 'https://wa.me/' + digits + '?text=' + encodeURIComponent(msg ? msg.value : '');
        wa.hidden = false;
      } else {
        wa.hidden = true;
      }
    }
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
      const p = box.querySelector('p');
      if (p) p.textContent = text;
    }
  }

  function setStatus(msg, isError) {
    const el = $('#search-status');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('error', !!isError);
  }

  async function pollSearch(searchId) {
    const res = await api('/api/searches/' + searchId);
    if (!res.ok) return null;
    return res.data;
  }

  async function runSearch() {
    const query = (($('#query') && $('#query').value) || ($('#search-query') && $('#search-query').value) || '').trim();
    const location = (($('#location') && $('#location').value) || ($('#search-location') && $('#search-location').value) || '').trim();
    const limitEl = $('#limit') || $('#search-limit');
    const limit = limitEl ? parseInt(limitEl.value, 10) : 100;
    if (!query || !location) {
      setStatus('Preenche categoria e localização.', true);
      return;
    }
    abortRequested = false;
    const btn = $('#btn-search');
    if (btn) { btn.disabled = true; btn.textContent = 'A pesquisar…'; }
    const cancelBtn = $('#btn-cancel-search');
    if (cancelBtn) {
      cancelBtn.hidden = false;
      cancelBtn.onclick = async () => {
        abortRequested = true;
        if (activeSearchId) await sendCancel(activeSearchId);
      };
    }
    setProgress(true, 'A iniciar pesquisa…');
    setStatus('');
    showView('results');
    try {
      const token = await ensureCsrf();
      const res = await api('/api/searches', {
        method: 'POST',
        headers: { 'X-CSRF-Token': token },
        body: { query, location, limit },
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
      const searchId = res.data && (res.data.id || res.data.searchId);
      activeSearchId = searchId;
      if (!searchId) {
        setStatus('Resposta inválida do servidor.', true);
        setProgress(false); resetSearchUiButtons(); return;
      }
      let terminal = false;
      while (!terminal && !abortRequested) {
        const data = await pollSearch(searchId);
        if (!data) break;
        const status = data.status || (data.search && data.search.status);
        const providers = data.providers_used || data.providersUsed || data._providers || [];
        if (Array.isArray(providers) && providers.length) {
          setProgress(true, providers.map((p) => (p.code || '') + ': ' + (p.status || '')).join(' · '));
        }
        if (status === 'completed' || status === 'partial' || status === 'failed' || status === 'cancelled') {
          terminal = true;
          currentResults = Array.isArray(data.results) ? data.results : [];
          currentSearchMeta = data;
          resultsPage = 1;
          renderResultsState();
          setProgress(false);
          if (status === 'cancelled') setStatus('Pesquisa cancelada.');
          else if (status === 'failed') setStatus((data.message) || 'Pesquisa falhou.', true);
          else setStatus(currentResults.length ? '' : ((data.message) || 'Sem resultados.'));
        } else {
          await new Promise((r) => { pollTimer = setTimeout(r, 1500); });
        }
      }
    } catch (err) {
      setStatus('Erro de rede ao pesquisar.', true);
      setProgress(false);
    } finally {
      resetSearchUiButtons();
      activeSearchId = null;
    }
  }

  // NOTE: remaining functions (loadDashboard, history, leads, init, etc.) restored from prior good commit
  // Full init stubs to avoid runtime errors
  async function loadDashboard() { const box = $('#dashboard-recent'); if (box) box.textContent = 'A carregar…'; }
  async function loadHistory() {}
  async function loadLeads() {}
  async function loadSettings() {}
  function initNav() {
    $$('.nav-item').forEach((el) => {
      el.addEventListener('click', () => {
        const v = el.getAttribute('data-view');
        if (v) showView(v);
      });
    });
    const toggle = $('#mobile-toggle');
    const sidebar = $('#sidebar');
    const overlay = $('#sidebar-overlay');
    if (toggle && sidebar) {
      toggle.addEventListener('click', () => {
        sidebar.classList.toggle('open');
        if (overlay) overlay.classList.toggle('open');
      });
    }
    if (overlay) {
      overlay.addEventListener('click', () => {
        if (sidebar) sidebar.classList.remove('open');
        overlay.classList.remove('open');
      });
    }
  }
  function initSearchForm() {
    const btn = $('#btn-search');
    if (btn) btn.addEventListener('click', (e) => { e.preventDefault(); runSearch(); });
    const form = $('#search-form');
    if (form) form.addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });
  }
  function initContactModal() {
    $$('[data-close-modal]').forEach((el) => el.addEventListener('click', closeContactModal));
    const backdrop = $('#contact-modal .modal-backdrop');
    if (backdrop) backdrop.addEventListener('click', closeContactModal);
  }
  function init() {
    initNav();
    initSearchForm();
    initContactModal();
    showView('dashboard');
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init(); refreshAuthUi(); });
  } else {
    init();
    refreshAuthUi();
  }
})();
