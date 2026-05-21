'use strict';

window.AdminAPI = (function () {
  function token() { return localStorage.getItem('inelmec_admin_token'); }
  function user() {
    try { return JSON.parse(localStorage.getItem('inelmec_admin_user') || 'null'); }
    catch { return null; }
  }

  async function req(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const t = token();
    if (t) headers.Authorization = 'Bearer ' + t;
    const res = await fetch('/api/admin' + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      localStorage.removeItem('inelmec_admin_token');
      localStorage.removeItem('inelmec_admin_user');
      location.href = '/admin/';
      return null;
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  }

  function logout() {
    localStorage.removeItem('inelmec_admin_token');
    localStorage.removeItem('inelmec_admin_user');
    location.href = '/admin/';
  }
  function ensureLogin() {
    if (!token()) location.href = '/admin/';
  }

  return {
    get: (p) => req('GET', p),
    post: (p, b) => req('POST', p, b),
    token, user, logout, ensureLogin,
  };
})();

window.fmt = {
  cop: (n) => '$' + Number(n || 0).toLocaleString('es-CO'),
  copCompact: (n) => {
    n = Number(n || 0);
    if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000)     return '$' + (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + 'k';
    return '$' + n.toLocaleString('es-CO');
  },
  date: (iso) => iso ? new Date(iso).toLocaleString('es-CO', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }) : '—',
  time: (iso) => iso ? new Date(iso).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }) : '—',
  relative: (iso) => {
    if (!iso) return '—';
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60_000) return 'hace ' + Math.floor(diff / 1000) + 's';
    if (diff < 3_600_000) return 'hace ' + Math.floor(diff / 60_000) + ' min';
    if (diff < 86_400_000) return 'hace ' + Math.floor(diff / 3_600_000) + ' h';
    return new Date(iso).toLocaleDateString('es-CO');
  },
  initials: (s) => (s || '').split(/[\s@]/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join(''),
  statusPill: (status) => {
    const map = {
      available:    ['green',  'Disponible'],
      occupied:     ['amber',  'En uso'],
      offline:      ['red',    'Sin conexión'],
      maintenance:  ['gray',   'Mantenimiento'],
      PENDING:      ['amber',  'Pendiente'],
      APPROVED:     ['green',  'Aprobado'],
      DECLINED:     ['red',    'Declinado'],
      VOIDED:       ['gray',   'Anulado'],
      ERROR:        ['red',    'Error'],
      NOT_STARTED:  ['gray',   'Sin iniciar'],
      ACTIVATING:   ['cyan',   'Activando'],
      ACTIVE:       ['green',  'Activo'],
      DEACTIVATING: ['amber',  'Apagando'],
      COMPLETED:    ['blue',   'Completado'],
      FAILED:       ['red',    'Fallido'],
      TIMEOUT:      ['red',    'Timeout'],
    };
    const [cls, label] = map[status] || ['gray', status];
    return `<span class="pill ${cls}">${label}</span>`;
  },
};

window.renderShell = function (activePage) {
  AdminAPI.ensureLogin();
  const u = AdminAPI.user() || {};
  const pages = [
    { k: 'dashboard', n: 'Dashboard',     i: icon('grid') },
    { k: 'chargers',  n: 'Cargadores',    i: icon('bolt') },
    { k: 'sessions',  n: 'Transacciones', i: icon('card') },
    { k: 'audit',     n: 'Auditoría',     i: icon('shield') },
    { k: 'webhooks',  n: 'Webhooks',      i: icon('plug') },
  ];
  return `
    <aside class="sidebar">
      <div class="brand">
        <div class="logo-icon">⚡</div>
        <div class="brand-text">INELMEC<small>EV Hub Admin</small></div>
      </div>

      <div class="section-label">Principal</div>
      <nav class="nav">
        ${pages.map((p) => `
          <a href="/admin/${p.k}.html" class="${activePage === p.k ? 'active' : ''}">
            <span class="ico">${p.i}</span>
            <span>${p.n}</span>
          </a>
        `).join('')}
      </nav>

      <div class="cta">
        <div class="title">⚡ Live Demo</div>
        <div class="desc">Tuya MOCK activo. Cambia a producción con sólo editar el .env.</div>
        <a href="/?qr=INL-001" target="_blank" class="btn outlined sm full">Ver flujo de usuario</a>
      </div>

      <div class="me">
        <div class="avatar">${fmt.initials(u.display_name || u.email)}</div>
        <div class="who">
          <b>${u.display_name || 'Admin'}</b>
          <small>${u.role || ''}</small>
        </div>
        <button class="logout" title="Cerrar sesión" onclick="AdminAPI.logout()">${icon('logout')}</button>
      </div>
    </aside>
  `;
};

// Tiny inline SVG icon set so we don't need an icon font / external lib
function icon(name) {
  const map = {
    grid:   '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
    bolt:   '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 4 14 11 14 11 22 20 10 13 10 13 2"/></svg>',
    card:   '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2.5"/><line x1="2" y1="10" x2="22" y2="10"/></svg>',
    shield: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3z"/><path d="m9 12 2 2 4-4"/></svg>',
    plug:   '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v6"/><path d="M15 2v6"/><path d="M5 8h14v4a7 7 0 0 1-14 0V8z"/><path d="M12 19v3"/></svg>',
    logout: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
    search: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    bell:   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
    moon:   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
    refresh:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
  };
  return map[name] || '';
}
window.icon = icon;
