// Server CRUD + demo seed data (with synthetic metrics backfill).
'use strict';

const os = require('os');
const { db, now } = require('./database');
const accessService = require('./accessService');
const { clamp, round1 } = require('../utils/helpers');

// Map a DB row to the public camelCase server shape.
function rowToServer(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    loader: row.loader,
    port: row.port,
    ramMb: row.ram_mb,
    cpuCores: row.cpu_cores,
    status: row.status,
    installed: Boolean(row.installed),
    icon: row.icon,
    createdAt: row.created_at,
  };
}

function rowToMetric(row) {
  if (!row) return null;
  return {
    ts: row.ts,
    cpu: row.cpu,
    ram: row.ram_mb,
    tps: row.tps,
    playersOnline: row.players_online,
    playersMax: row.players_max,
  };
}

function listServers(user) {
  const servers = db.prepare('SELECT * FROM servers ORDER BY id ASC').all();
  if (!user) return servers.map(rowToServer);
  const allowed = new Set(accessService.accessibleServerIds(user));
  return servers.filter((server) => allowed.has(server.id)).map(rowToServer);
}

function getServer(id) {
  return rowToServer(db.prepare('SELECT * FROM servers WHERE id = ?').get(id));
}

function latestMetric(serverId) {
  const row = db
    .prepare('SELECT * FROM metrics WHERE server_id = ? ORDER BY ts DESC, id DESC LIMIT 1')
    .get(serverId);
  return rowToMetric(row);
}

function maxCpuCores() {
  return Math.max(1, typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length);
}

function validateResources({ ramMb, cpuCores }, requireBoth = false) {
  if ((requireBoth || ramMb !== undefined) &&
      (!Number.isInteger(ramMb) || ramMb < 512 || ramMb > 65536)) {
    throw new Error('ramMb must be an integer between 512 and 65536');
  }
  if ((requireBoth || cpuCores !== undefined) &&
      (!Number.isInteger(cpuCores) || cpuCores < 1 || cpuCores > maxCpuCores())) {
    throw new Error(`cpuCores must be an integer between 1 and ${maxCpuCores()}`);
  }
}

function createServer({ name, version = '1.21.1', loader = 'vanilla', port = 25565, ramMb = 4096, cpuCores = 2, icon = 'grass' }) {
  validateResources({ ramMb, cpuCores }, true);
  const info = db
    .prepare('INSERT INTO servers (name, version, loader, port, ram_mb, cpu_cores, status, installed, icon, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)')
    .run(name, version, loader, port, ramMb, cpuCores, 'offline', icon, now());
  return getServer(info.lastInsertRowid);
}

function updateResources(id, resources) {
  const hasRam = Object.prototype.hasOwnProperty.call(resources || {}, 'ramMb');
  const hasCpu = Object.prototype.hasOwnProperty.call(resources || {}, 'cpuCores');
  if (!hasRam && !hasCpu) throw new Error('ramMb or cpuCores is required');
  validateResources(resources || {});
  const current = getServer(id);
  if (!current) return null;
  const ramMb = hasRam ? resources.ramMb : current.ramMb;
  const cpuCores = hasCpu ? resources.cpuCores : current.cpuCores;
  db.prepare('UPDATE servers SET ram_mb = ?, cpu_cores = ? WHERE id = ?')
    .run(ramMb, cpuCores, id);
  return getServer(id);
}

function deleteServer(id) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM metrics WHERE server_id = ?').run(id);
    db.prepare('DELETE FROM logs WHERE server_id = ?').run(id);
    db.prepare('DELETE FROM mods WHERE server_id = ?').run(id);
    db.prepare('DELETE FROM server_backup_settings WHERE server_id = ?').run(id);
    db.prepare('DELETE FROM servers WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function setStatus(id, status) {
  db.prepare('UPDATE servers SET status = ? WHERE id = ?').run(status, id);
}

function portTaken(port, excludeId = null) {
  const row = excludeId == null
    ? db.prepare('SELECT id FROM servers WHERE port = ?').get(port)
    : db.prepare('SELECT id FROM servers WHERE port = ? AND id != ?').get(port, excludeId);
  return !!row;
}

// --- Demo seed + metrics backfill -----------------------------------------

function backfillMetrics(serverId, ramMb) {
  const POINTS = 360;          // 3 hours at 30s intervals
  const STEP_MS = 30_000;
  const end = now();
  const insert = db.prepare(
    'INSERT INTO metrics (server_id, ts, cpu, ram_mb, tps, players_online, players_max) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  let cpu = 30 + Math.random() * 20;
  let players = Math.floor(Math.random() * 8);
  db.exec('BEGIN');
  try {
    for (let i = POINTS - 1; i >= 0; i--) {
      const ts = end - i * STEP_MS;
      const wave = Math.sin(ts / 300_000 + serverId * 1.7);
      cpu += (Math.random() - 0.5) * 6;
      cpu += (38 + 22 * wave - cpu) * 0.1; // pull toward moving baseline
      cpu = clamp(cpu, 5, 95);
      const ram = Math.round(ramMb * clamp(0.68 + 0.15 * wave + (Math.random() - 0.5) * 0.06, 0.5, 0.9));
      const tps = clamp(20 - Math.max(0, cpu - 85) * 0.15 - Math.random() * 0.3, 0, 20);
      players = clamp(players + Math.floor((Math.random() - 0.5) * 3), 0, 20);
      insert.run(serverId, ts, round1(cpu), ram, round1(tps), players, 20);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Seed 3 demo servers. Only runs when servers table is empty.
// Simulation mode: server 1 online + 3h metrics backfill per server.
// Real mode: all servers offline + installed=0, no metrics backfill.
function seedDemoData() {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM servers').get();
  if (c > 0) return false;

  const simulation = process.env.SIMULATION_MODE === 'true';
  const demo = simulation
    ? [
        { name: 'Survival Realm', version: '1.21.1', loader: 'paper', port: 25565, ramMb: 4096, icon: 'grass', status: 'online' },
        { name: 'Creative Plots', version: '1.20.4', loader: 'fabric', port: 25566, ramMb: 2048, icon: 'diamond', status: 'offline' },
        { name: 'Modded Adventures', version: '1.21.1', loader: 'forge', port: 25567, ramMb: 8192, icon: 'tnt', status: 'offline' },
      ]
    : [
        { name: 'Survival Realm', version: '1.21.1', loader: 'paper', port: 25565, ramMb: 4096, icon: 'grass', status: 'offline' },
        { name: 'Creative Plots', version: '1.20.4', loader: 'fabric', port: 25566, ramMb: 2048, icon: 'diamond', status: 'offline' },
        { name: 'Modded Adventures', version: '1.21.1', loader: 'forge', port: 25567, ramMb: 8192, icon: 'tnt', status: 'offline' },
      ];

  const insert = db.prepare(
    'INSERT INTO servers (name, version, loader, port, ram_mb, status, installed, icon, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)'
  );
  for (const s of demo) {
    const info = insert.run(s.name, s.version, s.loader, s.port, s.ramMb, s.status, s.icon, now());
    if (simulation) backfillMetrics(info.lastInsertRowid, s.ramMb);
  }
  console.log(simulation
    ? '[db] Seeded 3 demo servers with 3h of backfilled metrics each'
    : '[db] Seeded 3 demo servers (offline, not installed)');
  return true;
}

module.exports = {
  rowToServer,
  rowToMetric,
  listServers,
  getServer,
  latestMetric,
  createServer,
  updateResources,
  maxCpuCores,
  deleteServer,
  setStatus,
  portTaken,
  seedDemoData,
};
