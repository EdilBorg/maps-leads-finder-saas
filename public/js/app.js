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

  // REST OF FILE CONTINUES - truncated intentionally for test
  console.log('partial');
})();
