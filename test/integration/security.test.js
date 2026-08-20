'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { once } = require('events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-panel-test-'));
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-longer-than-thirty-two-characters';
process.env.SETUP_TOKEN = 'integration-setup-token-1234567890';
process.env.DB_FILE = path.join(root, 'data', 'panel.db');
process.env.SERVERS_DIR = path.join(root, 'servers');
process.env.BACKUPS_DIR = path.join(root, 'backups');
process.env.SIMULATION_MODE = 'true';
process.env.CORS_ORIGINS = '';

const { createPanel } = require('../../src/app');
const { db } = require('../../src/services/database');

test('security setup, auth, revocation, roles and audit log', async (t) => {
  const { server, io } = createPanel({ logging: false });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + url, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const data = await response.json();
    return { status: response.status, data };
  }

  await t.test('fresh database requires secured setup and has no default users', async () => {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0);
    assert.deepEqual(await request('/api/setup/status'), { status: 200, data: { setupRequired: true } });
    const denied = await request('/api/setup/admin', {
      method: 'POST',
      body: { username: 'owner', password: 'correct horse battery staple', passwordConfirm: 'correct horse battery staple', setupToken: 'wrong' },
    });
    assert.equal(denied.status, 403);
  });

  let adminToken;
  await t.test('one-time setup creates exactly one administrator', async () => {
    const payload = { username: 'owner', password: 'correct horse battery staple', passwordConfirm: 'correct horse battery staple', setupToken: process.env.SETUP_TOKEN };
    const attempts = await Promise.all([
      request('/api/setup/admin', { method: 'POST', body: payload }),
      request('/api/setup/admin', { method: 'POST', body: payload }),
    ]);
    attempts.sort((a, b) => a.status - b.status);
    const created = attempts[0];
    assert.equal(created.status, 201);
    assert.equal(attempts[1].status, 409);
    assert.equal(created.data.user.role, 'admin');
    adminToken = created.data.token;
    assert.equal((await request('/api/setup/status')).data.setupRequired, false);
    assert.equal((await request('/api/setup/admin', { method: 'POST', body: created.data })).status, 409);
  });

  await t.test('login and database-authoritative token work', async () => {
    assert.equal((await request('/api/auth/login', { method: 'POST', body: { username: 'owner', password: 'wrong password' } })).status, 401);
    const login = await request('/api/auth/login', { method: 'POST', body: { username: 'owner', password: 'correct horse battery staple' } });
    assert.equal(login.status, 200);
    adminToken = login.data.token;
    const me = await request('/api/auth/me', { token: adminToken });
    assert.equal(me.data.user.username, 'owner');
  });

  let viewerToken;
  let viewerId;
  await t.test('temporary user password is forced to change', async () => {
    const created = await request('/api/users', {
      method: 'POST', token: adminToken,
      body: { username: 'viewer1', password: 'temporary password 123', role: 'viewer' },
    });
    assert.equal(created.status, 201);
    viewerId = created.data.id;
    const login = await request('/api/auth/login', { method: 'POST', body: { username: 'viewer1', password: 'temporary password 123' } });
    assert.equal(login.data.user.mustChangePassword, true);
    assert.equal((await request('/api/servers', { token: login.data.token })).status, 403);
    const changed = await request('/api/auth/password', {
      method: 'POST', token: login.data.token,
      body: { currentPassword: 'temporary password 123', newPassword: 'viewer secure password 456', passwordConfirm: 'viewer secure password 456' },
    });
    assert.equal(changed.status, 200);
    viewerToken = changed.data.token;
    assert.equal((await request('/api/auth/me', { token: login.data.token })).status, 401);
  });

  await t.test('role checks and server mutations are enforced', async () => {
    const payload = { name: 'Test Server', version: '1.21.1', loader: 'vanilla', port: 25566, ramMb: 1024, cpuCores: 1 };
    assert.equal((await request('/api/servers', { method: 'POST', token: viewerToken, body: payload })).status, 403);
    assert.equal((await request('/api/servers', { method: 'POST', token: adminToken, body: payload })).status, 201);
  });

  await t.test('admin password reset requires reauthentication and revokes sessions', async () => {
    const payload = { newPassword: 'second temporary password 789', passwordConfirm: 'second temporary password 789' };
    assert.equal((await request(`/api/users/${viewerId}/password-reset`, {
      method: 'POST', token: adminToken, body: { ...payload, adminPassword: 'wrong password' },
    })).status, 403);
    assert.equal((await request(`/api/users/${viewerId}/password-reset`, {
      method: 'POST', token: adminToken, body: { ...payload, adminPassword: 'correct horse battery staple' },
    })).status, 200);
    assert.equal((await request('/api/auth/me', { token: viewerToken })).status, 401);
    const login = await request('/api/auth/login', {
      method: 'POST', body: { username: 'viewer1', password: payload.newPassword },
    });
    const changed = await request('/api/auth/password', {
      method: 'POST', token: login.data.token,
      body: { currentPassword: payload.newPassword, newPassword: 'viewer final password 987', passwordConfirm: 'viewer final password 987' },
    });
    viewerToken = changed.data.token;
  });

  await t.test('audit log is admin-only and contains mutations', async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await request('/api/admin/audit-events', { token: viewerToken })).status, 403);
    const audit = await request('/api/admin/audit-events', { token: adminToken });
    assert.equal(audit.status, 200);
    assert.ok(audit.data.events.some((event) => event.eventType === 'server.create'));
    assert.ok(audit.data.events.some((event) => event.eventType === 'auth.login'));
    const stored = JSON.stringify(db.prepare('SELECT * FROM audit_events').all());
    assert.equal(stored.includes('correct horse battery staple'), false);
    assert.equal(stored.includes(process.env.SETUP_TOKEN), false);
  });

  await t.test('password change revokes the previous administrator token', async () => {
    const changed = await request('/api/auth/password', {
      method: 'POST', token: adminToken,
      body: { currentPassword: 'correct horse battery staple', newPassword: 'new administrator password 789', passwordConfirm: 'new administrator password 789' },
    });
    assert.equal(changed.status, 200);
    assert.equal((await request('/api/auth/me', { token: adminToken })).status, 401);
    assert.equal((await request('/api/auth/me', { token: changed.data.token })).status, 200);
  });

  await new Promise((resolve) => io.close(resolve));
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
