// Database layer: Node 24 built-in SQLite (node:sqlite).
// Creates and migrates the SQLite schema on require.
'use strict';

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const { DatabaseSync } = require('node:sqlite');

const DB_FILE = process.env.DB_FILE || './data/panel.db';
const resolvedPath = path.resolve(DB_FILE);
fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

const db = new DatabaseSync(resolvedPath);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  token_version INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  password_changed_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor_user_id INTEGER,
  actor_username TEXT,
  actor_role TEXT,
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL,
  method TEXT,
  path TEXT,
  target_type TEXT,
  target_id TEXT,
  server_id INTEGER,
  status_code INTEGER,
  ip TEXT,
  user_agent TEXT,
  details_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_events_ts ON audit_events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_type ON audit_events(event_type, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_server ON audit_events(server_id, ts DESC);

CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  version TEXT DEFAULT '1.21.1',
  loader TEXT DEFAULT 'vanilla',
  port INTEGER DEFAULT 25565,
  ram_mb INTEGER DEFAULT 4096,
  cpu_cores INTEGER DEFAULT 2,
  status TEXT DEFAULT 'offline',
  icon TEXT DEFAULT 'grass',
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER,
  ts INTEGER,
  cpu REAL,
  ram_mb REAL,
  tps REAL,
  players_online INTEGER,
  players_max INTEGER
);
CREATE INDEX IF NOT EXISTS idx_metrics_server_ts ON metrics(server_id, ts);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER,
  ts INTEGER,
  line TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_server_ts ON logs(server_id, ts);

CREATE TABLE IF NOT EXISTS mods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER,
  provider TEXT,
  provider_project_id TEXT,
  name TEXT,
  version TEXT,
  file_name TEXT,
  icon_url TEXT,
  installed_at INTEGER,
  UNIQUE(server_id, provider, provider_project_id)
);

CREATE TABLE IF NOT EXISTS modpack_jobs (
  id TEXT PRIMARY KEY,
  server_id INTEGER,
  provider TEXT,
  modpack_id TEXT,
  name TEXT,
  status TEXT DEFAULT 'queued',
  percent REAL DEFAULT 0,
  stage TEXT,
  error TEXT,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS server_backup_settings (
  server_id INTEGER PRIMARY KEY,
  enabled INTEGER DEFAULT 0,
  interval_minutes INTEGER DEFAULT 1440,
  max_backups INTEGER DEFAULT 7,
  max_bytes INTEGER,
  next_run_at INTEGER,
  last_run_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS user_server_access (
  user_id INTEGER NOT NULL,
  server_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, server_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_server_access_server_id ON user_server_access(server_id);

CREATE TABLE IF NOT EXISTS modpack_update_state (
  server_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  provider_project_id TEXT NOT NULL,
  available INTEGER DEFAULT 0,
  latest_version_id TEXT,
  latest_version_name TEXT,
  checked_at INTEGER,
  PRIMARY KEY (server_id, provider, provider_project_id)
);
`);

// Legacy panel users used the role name "player"; it is now the read-only viewer role.
db.prepare("UPDATE users SET role = 'viewer' WHERE role = 'player'").run();

// User security columns for installations created before the setup workflow.
{
  const cols = db.prepare('PRAGMA table_info(users)').all();
  const add = (name, sql) => {
    if (!cols.some((column) => column.name === name)) db.exec(`ALTER TABLE users ADD COLUMN ${sql}`);
  };
  add('active', 'active INTEGER NOT NULL DEFAULT 1');
  add('token_version', 'token_version INTEGER NOT NULL DEFAULT 0');
  add('must_change_password', 'must_change_password INTEGER NOT NULL DEFAULT 0');
  add('password_changed_at', 'password_changed_at INTEGER');
  add('updated_at', 'updated_at INTEGER');
}

// Migration: add `installed` column to servers (0 = files not installed yet).
{
  const cols = db.prepare('PRAGMA table_info(servers)').all();
  if (!cols.some((c) => c.name === 'installed')) {
    db.exec('ALTER TABLE servers ADD COLUMN installed INTEGER DEFAULT 0');
    console.log('[db] Migration: added servers.installed column');
  }
  if (!cols.some((c) => c.name === 'cpu_cores')) {
    db.exec('ALTER TABLE servers ADD COLUMN cpu_cores INTEGER DEFAULT 2');
    console.log('[db] Migration: added servers.cpu_cores column');
  }
}

// Migration: add `mc_version` + `loader` columns to mods (modpack metadata).
{
  const cols = db.prepare('PRAGMA table_info(mods)').all();
  if (!cols.some((c) => c.name === 'mc_version')) {
    db.exec('ALTER TABLE mods ADD COLUMN mc_version TEXT');
    console.log('[db] Migration: added mods.mc_version column');
  }
  if (!cols.some((c) => c.name === 'loader')) {
    db.exec('ALTER TABLE mods ADD COLUMN loader TEXT');
    console.log('[db] Migration: added mods.loader column');
  }
  if (!cols.some((c) => c.name === 'version_id')) {
    db.exec('ALTER TABLE mods ADD COLUMN version_id TEXT');
    console.log('[db] Migration: added mods.version_id column');
  }
}

const now = () => Date.now();

// Existing installations are already initialized. A fresh database requires the
// one-time bootstrap workflow and never receives known default credentials.
{
  const existing = db.prepare("SELECT value FROM app_state WHERE key = 'setup_complete'").get();
  if (!existing) {
    const { count } = db.prepare('SELECT COUNT(*) AS count FROM users').get();
    db.prepare('INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run('setup_complete', count > 0 ? '1' : '0', now());
  }
}

// Known demo credentials must never remain usable after an upgrade.
for (const [username, password] of [['admin', 'admin123'], ['player', 'player123']]) {
  const user = db.prepare('SELECT id, role, password_hash FROM users WHERE username = ?').get(username);
  if (user && bcrypt.compareSync(password, user.password_hash)) {
    if (user.role === 'admin') {
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    } else {
      db.prepare(
        'UPDATE users SET active = 0, must_change_password = 1, token_version = token_version + 1, updated_at = ? WHERE id = ?'
      ).run(now(), user.id);
    }
  }
}
{
  const { count } = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = 1").get();
  if (count === 0) {
    db.prepare("UPDATE app_state SET value = '0', updated_at = ? WHERE key = 'setup_complete'").run(now());
  }
}

module.exports = { db, now };
