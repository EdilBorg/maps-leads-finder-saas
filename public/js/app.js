/**
 * Maps Leads Finder SaaS — Frontend shell (Vanilla JS)
 * Navigation, demo interactions, no real backend calls.
 */

(function () {
  'use strict';

  const titles = {
    dashboard: 'Dashboard',
    search: 'Nova pesquisa',
    results: 'Resultados',
    history: 'Histórico',
    leads: 'Leads guardados',
  };

  const DEMO_RESULTS = [
    {
      name: 'Clínica Sorriso',
      category: 'Clínica dentária',
      location: 'Maputo',
      phone: '+258 84 000 0001',
      email: 'contacto@demo.local',
      website: '—',
      rating: '4.6',
      reviews: '128',
      validation: 'Parcial',
    },
    {
      name: 'Restaurante Mar',
      category: 'Restaurante',
      location: 'Beira',
      phone: '+258 82 000 0002',
      email: '—',
      website: '—',
      rating: '4.2',
      reviews: '64',
      validation: 'Telefone',
    },
    {
      name: 'Auto Fix',
      category: 'Oficina',
      location: 'Nampula',
      phone: '+258 86 000 0003',
      email: 'oficina@demo.local',
      website: 'https://demo.example',
      rating: '3.9',
      reviews: '31',
      validation: 'Completo',
    },
    {
      name: 'Farmácia Central',
      category: 'Farmácia',
      location: 'Maputo',
      phone: '+258 84 000 0004',
      email: '—',
      website: '—',
      rating: '4.8',
      reviews: '210',
      validation: 'Telefone',
    },
    {
      name: 'Studio Design',
      category: 'Agência digital',
      location: 'Matola',
      phone: '—',
      email: 'hello@demo.local',
      website: 'https://studio.demo',
      rating: '4.4',
      reviews: '19',
      validation: 'Email',
    },
  ];

  let currentResults = [];

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }
  function $all(sel, root) {
    return Array.from((root || document).querySelectorAll(sel));
  }

  function navigate(view) {
    if (!titles[view]) return;

    $all('.view').forEach((el) => {
      el.classList.toggle('active', el.id === 'view-' + view);
    });

    $all('.nav-item[data-view]').forEach((btn) => {
      const active = btn.getAttribute('data-view') === view;
      btn.classList.toggle('active', active);
      if (active) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });

    const titleEl = $('#topbar-title');
    if (titleEl) titleEl.textContent = titles[view];

    const sidebar = $('#sidebar');
    const overlay = $('#sidebar-overlay');
    if (sidebar) sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('open');

    if (view === 'results') {
      renderResultsState();
    }

    try {
      history.replaceState(null, '', '#' + view);
    } catch (_) {}
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&')
      .replace(/</g, '<')
      .replace(/>/g, '>')
      .replace(/"/g, '"')
      .replace(/'/g, '&#39;');
  }

  function createTextCell(text, className) {
    const td = document.createElement('td');
    if (className) td.className = className;
    td.textContent = text == null ? '' : String(text);
    return td;
  }

  function renderResultsState() {
    const empty = $('#results-empty');
    const loading = $('#results-loading');
    const table = $('#results-table-wrap');
    const pagination = $('#results-pagination');

    if (loading && !loading.hidden) return;

    const has = currentResults.length > 0;
    if (empty) empty.hidden = has;
    if (table) table.hidden = !has;
    if (pagination) pagination.hidden = !has;

    if (has) {
      const body = $('#results-body');
      if (!body) return;

      while (body.firstChild) {
        body.removeChild(body.firstChild);
      }

      currentResults.forEach((r) => {
        const tr = document.createElement('tr');

        const tdCheck = document.createElement('td');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.setAttribute('aria-label', 'Selecionar');
        tdCheck.appendChild(cb);
        tr.appendChild(tdCheck);

        tr.appendChild(createTextCell(r.name, 'cell-name'));
        tr.appendChild(createTextCell(r.category));
        tr.appendChild(createTextCell(r.location));
        tr.appendChild(createTextCell(r.phone, 'mono'));
        tr.appendChild(createTextCell(r.email, 'mono'));
        tr.appendChild(createTextCell(r.website, 'mono'));
        tr.appendChild(createTextCell(r.rating));
        tr.appendChild(createTextCell(r.reviews));

        const tdVal = document.createElement('td');
        const badge = document.createElement('span');
        const badgeClass =
          r.validation === 'Completo'
            ? 'badge badge-success'
            : r.validation === 'Parcial'
              ? 'badge badge-warn'
              : 'badge badge-info';
        badge.className = badgeClass;
        badge.textContent = r.validation == null ? '' : String(r.validation);
        tdVal.appendChild(badge);
        tr.appendChild(tdVal);

        body.appendChild(tr);
      });

      const count = $('#results-count');
      if (count) count.textContent = currentResults.length + ' resultados (demo)';
    }
  }

  function simulateSearch() {
    const status = $('#search-status');
    const loading = $('#results-loading');
    const empty = $('#results-empty');
    const table = $('#results-table-wrap');
    const pagination = $('#results-pagination');

    if (status) status.textContent = 'Simulação em curso…';

    navigate('results');
    if (loading) loading.hidden = false;
    if (empty) empty.hidden = true;
    if (table) table.hidden = true;
    if (pagination) pagination.hidden = true;

    setTimeout(() => {
      currentResults = DEMO_RESULTS.slice();
      if (loading) loading.hidden = true;
      renderResultsState();
      if (status) status.textContent = 'Simulação concluída (dados de demonstração)';
    }, 700);
  }

  function initProviders() {
    $all('#provider-grid .provider-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const input = chip.querySelector('input');
        if (!input) return;
        setTimeout(() => {
          chip.classList.toggle('selected', input.checked);
        }, 0);
      });
    });
  }

  function init() {
    $all('.nav-item[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        navigate(btn.getAttribute('data-view'));
      });
    });

    $all('[data-nav]').forEach((btn) => {
      btn.addEventListener('click', () => navigate(btn.getAttribute('data-nav')));
    });

    const toggle = $('#mobile-toggle');
    const sidebar = $('#sidebar');
    const overlay = $('#sidebar-overlay');
    if (toggle && sidebar) {
      toggle.addEventListener('click', () => {
        sidebar.classList.toggle('open');
        if (overlay) overlay.classList.toggle('open', sidebar.classList.contains('open'));
      });
    }
    if (overlay) {
      overlay.addEventListener('click', () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('open');
      });
    }

    const form = $('#search-form');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const status = $('#search-status');
        if (status) {
          status.textContent =
            'Pesquisa real ainda não disponível. Use “Simular resultados (demo)”.';
        }
      });
    }

    const demoBtn = $('#btn-search-demo');
    if (demoBtn) demoBtn.addEventListener('click', simulateSearch);

    const filterInput = $('#results-filter');
    if (filterInput) {
      filterInput.addEventListener('input', () => {
        const q = filterInput.value.trim().toLowerCase();
        $all('#results-body tr').forEach((tr) => {
          const text = tr.textContent.toLowerCase();
          tr.style.display = !q || text.includes(q) ? '' : 'none';
        });
      });
    }

    initProviders();

    const hash = (location.hash || '#dashboard').replace('#', '');
    navigate(titles[hash] ? hash : 'dashboard');

    currentResults = [];
    renderResultsState();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
