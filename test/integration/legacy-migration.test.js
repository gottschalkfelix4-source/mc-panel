'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcrypt');
const { DatabaseSync } = require('node:sqlite');

test('known legacy demo credentials are disabled and setup is reopened securely', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-panel-legacy-'));
  const dbFile = path.join(root, 'panel.db');
  const legacy = new DatabaseSync(dbFile);
  legacy.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password_hash TEXT,
    role TEXT,
    created_at INTEGER
  )`);
  const insert = legacy.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)');
  insert.run('admin', bcrypt.hashSync('admin123', 10), 'admin', Date.now());
  insert.run('player', bcrypt.hashSync('player123', 10), 'viewer', Date.now());
  legacy.close();

  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'legacy-test-secret-that-is-longer-than-thirty-two';
  process.env.DB_FILE = dbFile;
  process.env.SERVERS_DIR = path.join(root, 'servers');
  process.env.BACKUPS_DIR = path.join(root, 'backups');
  process.env.SETUP_TOKEN = '';

  const { db } = require('../../src/services/database');
  const setupService = require('../../src/services/setupService');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users WHERE username = 'admin'").get().count, 0);
  const viewer = db.prepare("SELECT active, must_change_password FROM users WHERE username = 'player'").get();
  assert.equal(viewer.active, 0);
  assert.equal(viewer.must_change_password, 1);
  assert.equal(setupService.setupRequired(), true);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
