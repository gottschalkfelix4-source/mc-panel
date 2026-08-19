// Database layer: Node 24 built-in SQLite (node:sqlite).
// Creates the schema on require and seeds default users.
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
  username TEXT UNIQUE,
  password_hash TEXT,
  role TEXT DEFAULT 'player',
  created_at INTEGER
);

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

function seedUsers() {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM users').get();
  if (c > 0) return;
  const insert = db.prepare(
    'INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)'
  );
  insert.run('admin', bcrypt.hashSync('admin123', 10), 'admin', now());
  insert.run('player', bcrypt.hashSync('player123', 10), 'viewer', now());
  console.log('[db] Seeded default users: admin/admin123 (admin), player/player123 (viewer)');
}

seedUsers();

module.exports = { db, now };
