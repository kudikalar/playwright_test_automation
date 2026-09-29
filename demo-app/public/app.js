/* Shared client runtime for the reference application. */
const API = '/api/v1';
export const STORAGE_KEYS = { token: 'pk.auth.token', user: 'pk.auth.user' };

export const store = {
  get token() {
    return localStorage.getItem(STORAGE_KEYS.token);
  },
  get user() {
    const raw = localStorage.getItem(STORAGE_KEYS.user);
    return raw ? JSON.parse(raw) : null;
  },
  signIn(token, user) {
    localStorage.setItem(STORAGE_KEYS.token, token);
    localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(user));
    document.cookie = `pk_session=${token}; path=/; SameSite=Lax`;
  },
  signOut() {
    localStorage.removeItem(STORAGE_KEYS.token);
    localStorage.removeItem(STORAGE_KEYS.user);
    document.cookie = 'pk_session=; path=/; Max-Age=0';
  },
};

export async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (auth && store.token) headers.authorization = `Bearer ${store.token}`;
  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = response.status === 204 ? { success: true, data: null } : await response.json();
  return { status: response.status, ok: response.ok, ...payload };
}

export function requireAuth() {
  if (!store.token) {
    window.location.replace(`/login?redirect=${encodeURIComponent(window.location.pathname)}`);
    return false;
  }
  return true;
}

export function toast(message, variant = 'info', timeout = 4000) {
  const region = document.getElementById('toastRegion');
  if (!region) return;
  const node = document.createElement('div');
  node.className = 'toast';
  node.dataset.variant = variant;
  node.dataset.testid = 'toast';
  node.setAttribute('role', variant === 'error' ? 'alert' : 'status');
  node.textContent = message;
  region.append(node);
  if (timeout > 0) setTimeout(() => node.remove(), timeout);
}

export function mountShell(active) {
  const user = store.user;
  const nameEl = document.querySelector('[data-testid="current-user-name"]');
  if (nameEl && user) nameEl.textContent = user.name;
  const roleEl = document.querySelector('[data-testid="current-user-role"]');
  if (roleEl && user) roleEl.textContent = user.role;

  document.querySelectorAll('.sidebar a').forEach((link) => {
    if (link.dataset.nav === active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });

  document.querySelector('[data-testid="logout-button"]')?.addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    store.signOut();
    window.location.assign('/login');
  });

  document.querySelector('[data-testid="menu-toggle"]')?.addEventListener('click', () => {
    document.querySelector('.sidebar')?.classList.toggle('is-open');
  });
}

export function formatCurrency(value) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(Number(value ?? 0));
}

/* Accessible custom date picker used by the employee form. */
export function initDatePicker(root) {
  const input = root.querySelector('input[data-testid="date-input"]');
  const trigger = root.querySelector('[data-testid="date-picker-trigger"]');
  const pop = root.querySelector('[data-testid="date-picker-popup"]');
  const monthSelect = pop.querySelector('[data-testid="date-picker-month"]');
  const yearSelect = pop.querySelector('[data-testid="date-picker-year"]');
  const grid = pop.querySelector('[data-testid="date-picker-grid"]');
  const today = new Date();
  let view = { year: today.getFullYear(), month: today.getMonth() };

  const MONTHS = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  monthSelect.innerHTML = MONTHS.map((m, i) => `<option value="${i}">${m}</option>`).join('');
  const years = [];
  for (let y = today.getFullYear() - 8; y <= today.getFullYear() + 4; y += 1) years.push(y);
  yearSelect.innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join('');

  function render() {
    monthSelect.value = String(view.month);
    yearSelect.value = String(view.year);
    const first = new Date(view.year, view.month, 1);
    const days = new Date(view.year, view.month + 1, 0).getDate();
    const cells = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(
      (d) => `<div class="dow">${d}</div>`,
    );
    for (let i = 0; i < first.getDay(); i += 1) cells.push('<div></div>');
    for (let d = 1; d <= days; d += 1) {
      const iso = `${view.year}-${String(view.month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      cells.push(
        `<button type="button" data-date="${iso}" aria-selected="${input.value === iso}" aria-label="${iso}">${d}</button>`,
      );
    }
    grid.innerHTML = cells.join('');
  }

  const open = (isOpen) => {
    pop.hidden = !isOpen;
    trigger.setAttribute('aria-expanded', String(isOpen));
    if (isOpen) render();
  };

  trigger.addEventListener('click', () => open(pop.hidden));
  monthSelect.addEventListener('change', () => {
    view.month = Number(monthSelect.value);
    render();
  });
  yearSelect.addEventListener('change', () => {
    view.year = Number(yearSelect.value);
    render();
  });
  grid.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-date]');
    if (!button) return;
    input.value = button.dataset.date;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    open(false);
  });
  document.addEventListener('click', (event) => {
    if (!root.contains(event.target) && !pop.hidden) open(false);
  });

  return {
    setValue(iso) {
      input.value = iso;
      const [y, m] = iso.split('-').map(Number);
      view = { year: y, month: m - 1 };
    },
  };
}
