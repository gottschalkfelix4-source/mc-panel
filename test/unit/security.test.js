'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateUsername, validatePassword } = require('../../src/services/passwordPolicy');
const auditServicePath = require.resolve('../../src/services/auditService');

test('password policy rejects weak and bcrypt-truncated passwords', () => {
  assert.match(validatePassword('short'), /12 bis 128/);
  assert.match(validatePassword('admin123'), /12 bis 128|Standardpasswort/);
  assert.match(validatePassword('ä'.repeat(40)), /72 UTF-8-Bytes/);
  assert.equal(validatePassword('correct horse battery staple'), null);
});

test('username policy is bounded and predictable', () => {
  assert.equal(validateUsername('admin.user-1'), null);
  assert.ok(validateUsername('a'));
  assert.ok(validateUsername('invalid user'));
});

test('audit classifier maps sensitive actions without reading request bodies', () => {
  process.env.DB_FILE = process.env.DB_FILE || require('path').join(require('os').tmpdir(), `mc-panel-audit-${process.pid}.db`);
  delete require.cache[auditServicePath];
  const { classify } = require('../../src/services/auditService');
  assert.deepEqual(classify('POST', '/api/servers/12/start'), { eventType: 'server.power', serverId: 12 });
  assert.deepEqual(classify('POST', '/api/auth/password'), { eventType: 'auth.password.change', serverId: null });
  assert.equal(classify('GET', '/api/servers'), null);
});
