'use strict';

const fs = require('fs');
const path = require('path');
const { db, now } = require('./database');
const settingsService = require('./settingsService');

const fsp = fs.promises;
const BACKUPS_DIR = process.env.BACKUPS_DIR || './backups';
const GIB = 1024 ** 3;
const TIB = 1024 ** 4;

const KEYS = Object.freeze({
  GLOBAL_MAX_BYTES: 'backup_global_max_bytes',
  DEFAULT_SERVER_MAX_BYTES: 'backup_default_server_max_bytes',
});

const DEFAULTS = Object.freeze({
  GLOBAL_MAX_BYTES: 100 * GIB,
  DEFAULT_SERVER_MAX_BYTES: 20 * GIB,
});

const INTERVAL_MINUTES = Object.freeze([60, 180, 360, 720, 1440, 2880, 10080]);

function validation(message) {
  const err = new Error(message);
  err.code = 'VALIDATION';
  return err;
}

function forbidden(message) {
  const err = new Error(message);
  err.code = 'FORBIDDEN';
  return err;
}

function validServerId(serverId) {
  const id = Number(serverId);
  if (!Number.isInteger(id) || id <= 0) throw validation('Ungültige Server-ID');
  return id;
}

function storedInteger(key, fallback) {
  const value = settingsService.get(key);
  if (value == null) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function globalSettings() {
  return {
    globalMaxBytes: storedInteger(KEYS.GLOBAL_MAX_BYTES, DEFAULTS.GLOBAL_MAX_BYTES),
    defaultServerMaxBytes: storedInteger(
      KEYS.DEFAULT_SERVER_MAX_BYTES,
      DEFAULTS.DEFAULT_SERVER_MAX_BYTES
    ),
  };
}

function validateBytes(value, minimum, maximum, field) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw validation(`${field} muss eine ganze Zahl zwischen ${minimum} und ${maximum} sein`);
  }
}

function updateGlobal(changes = {}) {
  if (changes.globalMaxBytes !== undefined) {
    validateBytes(changes.globalMaxBytes, GIB, 10 * TIB, 'globalMaxBytes');
  }
  if (changes.defaultServerMaxBytes !== undefined) {
    validateBytes(changes.defaultServerMaxBytes, GIB, 10 * TIB, 'defaultServerMaxBytes');
  }
  if (changes.globalMaxBytes !== undefined) {
    settingsService.set(KEYS.GLOBAL_MAX_BYTES, changes.globalMaxBytes);
  }
  if (changes.defaultServerMaxBytes !== undefined) {
    settingsService.set(KEYS.DEFAULT_SERVER_MAX_BYTES, changes.defaultServerMaxBytes);
  }
  return globalSettings();
}

function serverSettings(serverId) {
  const id = validServerId(serverId);
  const row = db.prepare('SELECT * FROM server_backup_settings WHERE server_id = ?').get(id);
  const defaults = globalSettings();
  return {
    serverId: id,
    enabled: Boolean(row && row.enabled),
    intervalMinutes: row ? row.interval_minutes : 1440,
    maxBackups: row ? row.max_backups : 7,
    maxBytes: row && row.max_bytes != null ? row.max_bytes : defaults.defaultServerMaxBytes,
    nextRunAt: row ? row.next_run_at : null,
    lastRunAt: row ? row.last_run_at : null,
  };
}

function updateServer(serverId, changes = {}, isAdmin = false) {
  const id = validServerId(serverId);
  const row = db.prepare('SELECT * FROM server_backup_settings WHERE server_id = ?').get(id);
  const previousEnabled = Boolean(row && row.enabled);
  const previousInterval = row ? row.interval_minutes : 1440;

  let enabled = previousEnabled;
  let intervalMinutes = previousInterval;
  let maxBackups = row ? row.max_backups : 7;
  let maxBytes = row ? row.max_bytes : null;

  if (changes.enabled !== undefined) {
    if (typeof changes.enabled !== 'boolean') throw validation('enabled muss ein Boolean sein');
    enabled = changes.enabled;
  }
  if (changes.intervalMinutes !== undefined) {
    if (!INTERVAL_MINUTES.includes(changes.intervalMinutes)) {
      throw validation(`intervalMinutes muss einer der Werte ${INTERVAL_MINUTES.join(', ')} sein`);
    }
    intervalMinutes = changes.intervalMinutes;
  }
  if (changes.maxBackups !== undefined) {
    if (!Number.isInteger(changes.maxBackups) || changes.maxBackups < 1 || changes.maxBackups > 100) {
      throw validation('maxBackups muss eine ganze Zahl zwischen 1 und 100 sein');
    }
    maxBackups = changes.maxBackups;
  }
  if (changes.maxBytes !== undefined) {
    if (!isAdmin) throw forbidden('Nur Admins dürfen das Backup-Speicherlimit ändern');
    validateBytes(changes.maxBytes, 512 * 1024 ** 2, 2 * TIB, 'maxBytes');
    maxBytes = changes.maxBytes;
  }

  let nextRunAt = row ? row.next_run_at : null;
  if (!enabled) {
    nextRunAt = null;
  } else if (!previousEnabled || intervalMinutes !== previousInterval || nextRunAt == null) {
    nextRunAt = now() + intervalMinutes * 60_000;
  }

  db.prepare(
    `INSERT INTO server_backup_settings
       (server_id, enabled, interval_minutes, max_backups, max_bytes, next_run_at, last_run_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(server_id) DO UPDATE SET
       enabled = excluded.enabled,
       interval_minutes = excluded.interval_minutes,
       max_backups = excluded.max_backups,
       max_bytes = excluded.max_bytes,
       next_run_at = excluded.next_run_at,
       last_run_at = excluded.last_run_at,
       updated_at = excluded.updated_at`
  ).run(
    id,
    enabled ? 1 : 0,
    intervalMinutes,
    maxBackups,
    maxBytes,
    nextRunAt,
    row ? row.last_run_at : null,
    now()
  );

  return serverSettings(id);
}

function dueServers(timestamp = now()) {
  return db.prepare(
    `SELECT s.id, s.name, b.next_run_at AS nextRunAt
       FROM servers s
       JOIN server_backup_settings b ON b.server_id = s.id
      WHERE b.enabled = 1
        AND b.next_run_at <= ?
        AND s.status = 'offline'
      ORDER BY b.next_run_at ASC`
  ).all(timestamp);
}

function markScheduled(serverId, success) {
  const id = validServerId(serverId);
  const timestamp = now();
  if (success) {
    db.prepare(
      `UPDATE server_backup_settings
          SET last_run_at = ?, next_run_at = ? + interval_minutes * 60000, updated_at = ?
        WHERE server_id = ?`
    ).run(timestamp, timestamp, timestamp, id);
  } else {
    db.prepare(
      `UPDATE server_backup_settings
          SET next_run_at = ? + interval_minutes * 60000, updated_at = ?
        WHERE server_id = ?`
    ).run(timestamp, timestamp, id);
  }
  return serverSettings(id);
}

async function scanZipFiles(root) {
  let rootStat;
  try {
    rootStat = await fsp.lstat(root);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw validation('Backup-Verzeichnis ist ungültig');
  }

  const files = [];
  async function walk(directory) {
    const names = await fsp.readdir(directory);
    for (const name of names) {
      const absolute = path.join(directory, name);
      let stat;
      try {
        stat = await fsp.lstat(absolute);
      } catch (err) {
        if (err.code === 'ENOENT') continue;
        throw err;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        await walk(absolute);
      } else if (stat.isFile() && name.toLowerCase().endsWith('.zip')) {
        files.push({ absolute, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  }
  await walk(root);
  return files;
}

async function usage(serverId) {
  const backupRoot = path.resolve(process.cwd(), BACKUPS_DIR);
  const allFiles = await scanZipFiles(backupRoot);
  const globalBytes = allFiles.reduce((sum, file) => sum + file.size, 0);
  const globalCount = allFiles.length;
  if (serverId === undefined || serverId === null) return { globalBytes, globalCount };

  const id = validServerId(serverId);
  const serverRoot = path.join(backupRoot, String(id));
  const serverFiles = allFiles.filter(
    (file) => file.absolute.startsWith(serverRoot + path.sep) && path.relative(serverRoot, file.absolute)
  );
  return {
    serverBytes: serverFiles.reduce((sum, file) => sum + file.size, 0),
    globalBytes,
    serverCount: serverFiles.length,
    globalCount,
  };
}

async function checkQuota(serverId, estimatedBytes, reservedGlobal = 0, reservedServer = 0) {
  const id = validServerId(serverId);
  for (const [value, field] of [
    [estimatedBytes, 'estimatedBytes'],
    [reservedGlobal, 'reservedGlobal'],
    [reservedServer, 'reservedServer'],
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) throw validation(`${field} ist ungültig`);
  }

  const currentUsage = await usage(id);
  const server = serverSettings(id);
  const global = globalSettings();
  const limits = { serverMaxBytes: server.maxBytes, globalMaxBytes: global.globalMaxBytes };
  let reason = null;
  if (currentUsage.serverBytes + reservedServer + estimatedBytes > limits.serverMaxBytes) {
    reason = 'Das Backup überschreitet das Speicherlimit dieses Servers.';
  } else if (currentUsage.globalBytes + reservedGlobal + estimatedBytes > limits.globalMaxBytes) {
    reason = 'Das Backup überschreitet das globale Backup-Speicherlimit.';
  }
  return { allowed: reason == null, reason, usage: currentUsage, limits };
}

async function pruneCount(serverId) {
  const id = validServerId(serverId);
  const backupRoot = path.resolve(process.cwd(), BACKUPS_DIR, String(id));
  const files = await scanZipFiles(backupRoot);
  const { maxBackups } = serverSettings(id);
  const createdAt = (file) => {
    const match = path.basename(file.absolute).match(/^(\d+)-/);
    return match ? Number(match[1]) : file.mtimeMs;
  };
  files.sort((a, b) => createdAt(a) - createdAt(b) || a.absolute.localeCompare(b.absolute));
  const removeCount = Math.max(0, files.length - maxBackups + 1);
  for (let index = 0; index < removeCount; index += 1) {
    await fsp.unlink(files[index].absolute);
  }
  return removeCount;
}

module.exports = {
  KEYS,
  DEFAULTS,
  INTERVAL_MINUTES,
  globalSettings,
  updateGlobal,
  serverSettings,
  updateServer,
  dueServers,
  markScheduled,
  usage,
  checkQuota,
  pruneCount,
};
