'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const baseEnv = {
  ...process.env,
  NODE_ENV: 'production',
  JWT_SECRET: 'production-test-secret-with-at-least-thirty-two-characters',
  CORS_ORIGINS: '',
  SETUP_TOKEN: '',
};

function loadConfig(env) {
  return spawnSync(process.execPath, ['-e', "require('./src/config')"], {
    cwd: root,
    env: { ...baseEnv, ...env },
    encoding: 'utf8',
  });
}

test('production configuration rejects weak secrets and setup tokens', () => {
  assert.notEqual(loadConfig({ JWT_SECRET: 'short' }).status, 0);
  assert.notEqual(loadConfig({ SETUP_TOKEN: 'weak-token' }).status, 0);
  assert.notEqual(loadConfig({ CORS_ORIGINS: '*' }).status, 0);
});

test('production configuration accepts explicit strong values', () => {
  assert.equal(loadConfig({ SETUP_TOKEN: 'strong-setup-token-1234567890123456' }).status, 0);
});
