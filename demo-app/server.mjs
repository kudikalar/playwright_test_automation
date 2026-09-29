/**
 * Reference application under test.
 *
 * A dependency-free Node server exposing an accessible UI and a REST API, used so the
 * framework can be executed, demonstrated and verified end-to-end without depending on an
 * external environment. Point `config/environments/*.json` at a real application to swap it out.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const PORT = Number(process.env.DEMO_APP_PORT ?? 4321);
const API_PREFIX = '/api/v1';

/* ------------------------------------------------------------------ users -- */
const USERS = [
  {
    id: 'usr-admin',
    email: process.env.ADMIN_USERNAME ?? 'admin@prakura.io',
    password: process.env.ADMIN_PASSWORD ?? 'Admin@12345',
    name: 'Aarav Admin',
    role: 'ADMIN',
  },
  {
    id: 'usr-manager',
    email: process.env.MANAGER_USERNAME ?? 'manager@prakura.io',
    password: process.env.MANAGER_PASSWORD ?? 'Manager@12345',
    name: 'Meera Manager',
    role: 'MANAGER',
  },
  {
    id: 'usr-employee',
    email: process.env.EMPLOYEE_USERNAME ?? 'employee@prakura.io',
    password: process.env.EMPLOYEE_PASSWORD ?? 'Employee@12345',
    name: 'Evan Employee',
    role: 'EMPLOYEE',
  },
];

const API_KEY = process.env.API_KEY ?? 'local-dev-api-key';
const sessions = new Map(); // token -> userId

/* -------------------------------------------------------------- employees -- */
const DEPARTMENTS = ['Engineering', 'Quality Assurance', 'Human Resources', 'Finance', 'Sales'];
const employees = new Map();

function seed() {
  const seedRows = [
    ['Kiran Rao', 'kiran.rao@prakura.io', 'Engineering', 'Senior Engineer', 1450000, '2021-04-12'],
    ['Divya Nair', 'divya.nair@prakura.io', 'Quality Assurance', 'SDET', 1180000, '2022-01-03'],
    [
      'Rahul Menon',
      'rahul.menon@prakura.io',
      'Human Resources',
      'HR Partner',
      900000,
      '2020-09-21',
    ],
    ['Sara Iyer', 'sara.iyer@prakura.io', 'Finance', 'Analyst', 980000, '2023-06-15'],
    ['Vikram Shah', 'vikram.shah@prakura.io', 'Sales', 'Account Executive', 1050000, '2019-11-01'],
    ['Neha Gupta', 'neha.gupta@prakura.io', 'Engineering', 'Staff Engineer', 1750000, '2018-02-19'],
    ['Arjun Das', 'arjun.das@prakura.io', 'Quality Assurance', 'QA Lead', 1320000, '2021-08-30'],
    ['Priya Kulkarni', 'priya.k@prakura.io', 'Engineering', 'Engineer', 1120000, '2023-03-06'],
  ];
  for (const [name, email, department, designation, salary, joiningDate] of seedRows) {
    const id = `emp-seed-${email.split('@')[0].replace(/\./g, '-')}`;
    employees.set(id, {
      id,
      name,
      email,
      department,
      designation,
      salary,
      joiningDate,
      status: 'ACTIVE',
      seeded: true,
      createdAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
      updatedAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
    });
  }
}
seed();

/* ---------------------------------------------------------------- helpers -- */
const json = (res, status, body, headers = {}) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-request-id': randomUUID(),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
};

const fail = (res, status, code, message, details) =>
  json(res, status, { success: false, error: { code, message, ...(details ? { details } : {}) } });

const ok = (res, data, status = 200, meta) =>
  json(res, status, { success: true, data, ...(meta ? { meta } : {}) });

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return Symbol.for('invalid-json');
  }
}

function authenticate(req) {
  const header = req.headers.authorization ?? '';
  const apiKey = req.headers['x-api-key'];
  if (header.startsWith('Bearer ')) {
    const userId = sessions.get(header.slice(7).trim());
    if (!userId) return { error: 'INVALID_TOKEN' };
    return { user: USERS.find((u) => u.id === userId) };
  }
  if (apiKey) {
    if (apiKey !== API_KEY) return { error: 'INVALID_API_KEY' };
    return { user: USERS.find((u) => u.role === 'ADMIN') };
  }
  return { error: 'MISSING_CREDENTIALS' };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validateEmployee(payload, { partial = false } = {}) {
  const errors = [];
  const required = ['name', 'email', 'department', 'designation'];
  for (const field of required) {
    if (!partial && (payload[field] === undefined || String(payload[field]).trim() === '')) {
      errors.push({ field, message: `${field} is required` });
    }
  }
  if (payload.email !== undefined && !EMAIL_RE.test(String(payload.email))) {
    errors.push({ field: 'email', message: 'email must be a valid address' });
  }
  if (payload.department !== undefined && !DEPARTMENTS.includes(payload.department)) {
    errors.push({
      field: 'department',
      message: `department must be one of ${DEPARTMENTS.join(', ')}`,
    });
  }
  if (
    payload.salary !== undefined &&
    (Number.isNaN(Number(payload.salary)) || Number(payload.salary) < 0)
  ) {
    errors.push({ field: 'salary', message: 'salary must be a positive number' });
  }
  return errors;
}

/* ------------------------------------------------------------- api router -- */
async function handleApi(req, res, url) {
  const path = url.pathname.slice(API_PREFIX.length) || '/';
  const method = req.method ?? 'GET';

  if (path === '/health') {
    return ok(res, {
      status: 'UP',
      uptimeSeconds: Math.round(process.uptime()),
      employees: employees.size,
    });
  }

  if (path === '/auth/login' && method === 'POST') {
    const body = await readBody(req);
    if (typeof body === 'symbol')
      return fail(res, 400, 'MALFORMED_JSON', 'Request body is not valid JSON');
    const { username, password } = body;
    if (!username || !password)
      return fail(res, 400, 'VALIDATION_ERROR', 'username and password are required');
    const user = USERS.find((u) => u.email.toLowerCase() === String(username).toLowerCase());
    if (!user || user.password !== password)
      return fail(res, 401, 'INVALID_CREDENTIALS', 'Invalid credentials');
    const token = `tkn_${randomUUID()}`;
    sessions.set(token, user.id);
    return ok(res, {
      token,
      expiresIn: 3600,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  }

  const auth = authenticate(req);
  if (auth.error) {
    return fail(res, 401, 'UNAUTHORIZED', 'Authentication required', { reason: auth.error });
  }
  const currentUser = auth.user;

  if (path === '/auth/me' && method === 'GET') {
    return ok(res, {
      id: currentUser.id,
      email: currentUser.email,
      name: currentUser.name,
      role: currentUser.role,
    });
  }

  if (path === '/auth/logout' && method === 'POST') {
    const header = req.headers.authorization ?? '';
    sessions.delete(header.slice(7).trim());
    return ok(res, { loggedOut: true });
  }

  if (path === '/users' && method === 'GET') {
    if (currentUser.role !== 'ADMIN')
      return fail(res, 403, 'FORBIDDEN', 'ADMIN role required to list users');
    return ok(
      res,
      USERS.map(({ password: _password, ...rest }) => rest),
    );
  }

  if (path === '/departments' && method === 'GET') return ok(res, DEPARTMENTS);

  if (path === '/employees' && method === 'GET') {
    const search = (url.searchParams.get('search') ?? '').toLowerCase();
    const department = url.searchParams.get('department');
    const sortBy = url.searchParams.get('sortBy') ?? 'name';
    const sortOrder = url.searchParams.get('sortOrder') === 'desc' ? -1 : 1;
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') ?? 10)));

    let rows = [...employees.values()];
    if (search)
      rows = rows.filter((e) =>
        [e.name, e.email, e.designation, e.department].some((v) =>
          String(v).toLowerCase().includes(search),
        ),
      );
    if (department) rows = rows.filter((e) => e.department === department);
    rows.sort((a, b) => {
      const x = a[sortBy] ?? '';
      const y = b[sortBy] ?? '';
      return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * sortOrder;
    });

    const total = rows.length;
    const start = (page - 1) * pageSize;
    return ok(res, rows.slice(start, start + pageSize), 200, {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  }

  if (path === '/employees' && method === 'POST') {
    const body = await readBody(req);
    if (typeof body === 'symbol')
      return fail(res, 400, 'MALFORMED_JSON', 'Request body is not valid JSON');
    const errors = validateEmployee(body);
    if (errors.length)
      return fail(res, 422, 'VALIDATION_ERROR', 'Employee payload is invalid', errors);
    if (
      [...employees.values()].some(
        (e) => e.email.toLowerCase() === String(body.email).toLowerCase(),
      )
    )
      return fail(res, 409, 'DUPLICATE_EMAIL', 'An employee with that email already exists');

    const now = new Date().toISOString();
    const employee = {
      id: `emp-${randomUUID()}`,
      name: String(body.name).trim(),
      email: String(body.email).trim(),
      department: body.department,
      designation: String(body.designation).trim(),
      salary: Number(body.salary ?? 0),
      joiningDate: body.joiningDate ?? now.slice(0, 10),
      status: body.status ?? 'ACTIVE',
      seeded: false,
      createdAt: now,
      updatedAt: now,
    };
    employees.set(employee.id, employee);
    return ok(res, employee, 201, undefined);
  }

  const employeeMatch = /^\/employees\/([^/]+)$/.exec(path);
  if (employeeMatch) {
    const id = decodeURIComponent(employeeMatch[1]);
    const existing = employees.get(id);

    if (method === 'GET') {
      if (!existing) return fail(res, 404, 'NOT_FOUND', `Employee ${id} was not found`);
      return ok(res, existing);
    }

    if (method === 'PUT' || method === 'PATCH') {
      if (!existing) return fail(res, 404, 'NOT_FOUND', `Employee ${id} was not found`);
      const body = await readBody(req);
      if (typeof body === 'symbol')
        return fail(res, 400, 'MALFORMED_JSON', 'Request body is not valid JSON');
      const errors = validateEmployee(body, { partial: method === 'PATCH' });
      if (errors.length)
        return fail(res, 422, 'VALIDATION_ERROR', 'Employee payload is invalid', errors);
      const updated = {
        ...existing,
        ...(method === 'PUT'
          ? body
          : Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined))),
        id: existing.id,
        updatedAt: new Date().toISOString(),
      };
      employees.set(id, updated);
      return ok(res, updated);
    }

    if (method === 'DELETE') {
      if (!['ADMIN', 'MANAGER'].includes(currentUser.role))
        return fail(res, 403, 'FORBIDDEN', 'ADMIN or MANAGER role required to delete an employee');
      if (!existing) return fail(res, 404, 'NOT_FOUND', `Employee ${id} was not found`);
      if (existing.seeded)
        return fail(res, 409, 'PROTECTED_RECORD', 'Seeded reference records cannot be deleted');
      employees.delete(id);
      res.writeHead(204).end();
      return;
    }
  }

  return fail(res, 404, 'ROUTE_NOT_FOUND', `No API route for ${method} ${url.pathname}`);
}

/* ---------------------------------------------------------- static router -- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

const ROUTES = {
  '/': 'login.html',
  '/login': 'login.html',
  '/dashboard': 'dashboard.html',
  '/employees': 'employees.html',
  '/profile': 'profile.html',
  '/widget': 'widget.html',
};

async function handleStatic(req, res, url) {
  const mapped = ROUTES[url.pathname];
  const relative = mapped ?? normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>404</title><h1>404 – Page not found</h1>');
    return;
  }
  const body = await readFile(filePath);
  res.writeHead(200, {
    'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(body);
}

/* ----------------------------------------------------------------- server -- */
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `localhost:${PORT}`}`);

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader(
    'access-control-allow-headers',
    'content-type, authorization, x-api-key, x-correlation-id',
  );
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();

  const route = url.pathname.startsWith(API_PREFIX)
    ? handleApi(req, res, url)
    : handleStatic(req, res, url);

  Promise.resolve(route).catch((error) => {
    console.error('[demo-app] unhandled error', error);
    if (!res.headersSent) fail(res, 500, 'INTERNAL_ERROR', 'Unexpected server error');
  });
});

server.listen(PORT, () => {
  console.log(`[demo-app] listening on http://127.0.0.1:${PORT} (API ${API_PREFIX})`);
});
