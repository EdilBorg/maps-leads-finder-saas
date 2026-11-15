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
  let currentSearchMeta = null;
  let resultsPage = 1;
  let historyPage = 1;
  let historyRequestSeq = 0;
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
    if (view === 'history') {
      historyPage = 1;
      loadHistory();
    }
    if (view === 'leads') loadLeads();
    if (view === 'settings') loadSettings();
  }

  /** Scroll the app's real scroll container (.main) so the active view starts at the top. */
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
