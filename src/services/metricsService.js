// Metrics service: collects + persists per-server metrics on an interval,
// exposes history (downsampled) and a cluster summary.
// Simulation mode: synthetic random walk. Real mode: pidusage on the JVM pid.
'use strict';

const pidusage = require('pidusage');
const os = require('os');
const fs = require('fs');
const { db, now } = require('./database');
const processManager = require('./processManager');
const { clamp, round1 } = require('../utils/helpers');

const INTERVAL_MS = parseInt(process.env.METRICS_INTERVAL_MS || '2000', 10);
const RETENTION_HOURS = parseFloat(process.env.METRICS_RETENTION_HOURS || '48');
const PLAYERS_MAX = 20;
const HISTORY_MAX_POINTS = 360;

let io = null;
let tickTimer = null;
let pruneTimer = null;

// serverId -> random-walk state (simulation mode)
const walk = new Map();
// serverId -> latest emitted metric (for summary)
const lastMetrics = new Map();
// serverId -> first tick timestamp while 'starting' (real-mode ramp)
const startingSince = new Map();

function getWalk(serverId) {
  if (!walk.has(serverId)) {
    walk.set(serverId, {
      cpu: 30 + Math.random() * 20,
      players: Math.floor(Math.random() * 8),
      phase: Math.random() * Math.PI * 2,
      startedAt: now(),
    });
  }
  return walk.get(serverId);
}

function computeMetric(server, st, ts) {
  // Ramp-up for freshly 'starting' servers.
  const ramp = server.status === 'starting' ? clamp((ts - st.startedAt) / 8000, 0.1, 1) : 1;

  const wave = Math.sin(ts / 300_000 + st.phase); // ~5 min period sine

  // CPU: smooth random walk pulled toward a sine baseline.
  st.cpu += (Math.random() - 0.5) * 8;
  st.cpu += (40 + 25 * wave - st.cpu) * 0.08;
  const cpu = clamp(st.cpu * ramp + 5, 5, 95);

  // RAM: 50-90% of allocation while online, scaled by ramp while starting.
  const ram = Math.round(
    clamp(
      server.ram_mb * (0.7 + 0.15 * wave + (Math.random() - 0.5) * 0.06) * ramp,
      server.ram_mb * 0.1,
      server.ram_mb * 0.9
    )
  );

  // TPS: near 20, dips when CPU is hot.
  let tps = 20 - Math.max(0, cpu - 85) * 0.12 - Math.random() * 0.25;
  if (server.status === 'starting') tps *= ramp;
  tps = clamp(tps, 0, 20);

  // Players: slow random walk, clamped.
  if (Math.random() < 0.15) st.players += Math.random() < 0.5 ? -1 : 1;
  st.players = clamp(st.players, 0, PLAYERS_MAX);

  return {
    serverId: server.id,
    ts,
    cpu: round1(cpu),
    ram,
    tps: round1(tps),
    playersOnline: st.players,
    playersMax: PLAYERS_MAX,
  };
}

// Real mode: measure the actual JVM process via pidusage.
async function computeRealMetric(server, ts) {
  const info = processManager.getRuntimeInfo(server.id);
  if (!info || info.pid == null) return null; // no live process -> skip tick

  let stats;
  try {
    stats = await pidusage(info.pid);
  } catch {
    return null; // process gone between status check and measurement
  }

  // Freshly starting servers ramp up like in simulation.
  let ramp = 1;
  if (server.status === 'starting') {
    if (!startingSince.has(server.id)) startingSince.set(server.id, ts);
    ramp = clamp((ts - startingSince.get(server.id)) / 8000, 0.1, 1);
  } else {
    startingSince.delete(server.id);
  }

  const cpuCores = Math.max(1, Number(server.cpu_cores) || 1);
  const cpu = round1(clamp(stats.cpu / cpuCores, 0, 100) * ramp);
  const ram = round1(clamp(stats.memory / 1048576, 0, server.ram_mb) * ramp);

  // TPS: parsed from the server console on Paper; otherwise assume 20 with a
  // cpu-based dip.
  let tps = typeof info.tps === 'number' ? info.tps : 20;
  if (server.loader !== 'paper') {
    tps = 20 - Math.max(0, cpu - 85) * 0.12;
  }
  tps = round1(clamp(tps, 0, 20));

  return {
    serverId: server.id,
    ts,
    cpu,
    ram,
    tps,
    playersOnline: info.playersOnline || 0,
    playersMax: info.playersMax || PLAYERS_MAX,
  };
}

async function tickReal(servers, insert, ts) {
  for (const server of servers) {
    const m = await computeRealMetric(server, ts);
    if (!m) continue;
    try {
      insert.run(m.serverId, m.ts, m.cpu, m.ram, m.tps, m.playersOnline, m.playersMax);
    } catch {
      // Server deleted mid-tick; skip persistence but still emit.
    }
    lastMetrics.set(m.serverId, m);
    if (io) io.to(`server:${m.serverId}`).emit('metrics:tick', m);
  }
}

function tickOnce() {
  const servers = db
    .prepare("SELECT * FROM servers WHERE status IN ('online', 'starting')")
    .all();
  if (servers.length === 0) return;

  const ts = now();
  const insert = db.prepare(
    'INSERT INTO metrics (server_id, ts, cpu, ram_mb, tps, players_online, players_max) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );

  if (processManager.getMode() === 'real') {
    tickReal(servers, insert, ts).catch(() => {});
    return;
  }

  for (const server of servers) {
    const m = computeMetric(server, getWalk(server.id), ts);
    try {
      insert.run(m.serverId, m.ts, m.cpu, m.ram, m.tps, m.playersOnline, m.playersMax);
    } catch {
      // Server deleted mid-tick; skip persistence but still emit.
    }
    lastMetrics.set(m.serverId, m);
    if (io) io.to(`server:${m.serverId}`).emit('metrics:tick', m);
  }
}

function prune() {
  const cutoff = now() - RETENTION_HOURS * 3600_000;
  const info = db.prepare('DELETE FROM metrics WHERE ts < ?').run(cutoff);
  if (info.changes > 0) console.log(`[metrics] Pruned ${info.changes} rows older than ${RETENTION_HOURS}h`);
}

function start(ioInstance) {
  io = ioInstance;
  if (tickTimer) return;
  prune(); // initial cleanup on boot
  tickTimer = setInterval(tickOnce, INTERVAL_MS);
  pruneTimer = setInterval(prune, 10 * 60 * 1000); // every 10 minutes
  console.log(`[metrics] Ticking every ${INTERVAL_MS}ms, retention ${RETENTION_HOURS}h`);
}

function stop() {
  if (tickTimer) clearInterval(tickTimer);
  if (pruneTimer) clearInterval(pruneTimer);
  tickTimer = null;
  pruneTimer = null;
}

// Bucket-average downsample to at most HISTORY_MAX_POINTS points.
function downsample(rows) {
  if (rows.length <= HISTORY_MAX_POINTS) return rows;
  const chunk = Math.ceil(rows.length / HISTORY_MAX_POINTS);
  const out = [];
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const avg = (k) => slice.reduce((a, r) => a + r[k], 0) / slice.length;
    out.push({
      ts: Math.round(avg('ts')),
      cpu: round1(avg('cpu')),
      ram: Math.round(avg('ram')),
      tps: round1(avg('tps')),
      playersOnline: Math.round(avg('playersOnline')),
      playersMax: PLAYERS_MAX,
    });
  }
  return out;
}

function getHistory(serverId, minutes = 60) {
  const since = now() - minutes * 60_000;
  const rows = db
    .prepare(
      `SELECT ts, cpu, ram_mb AS ram, tps, players_online AS playersOnline, players_max AS playersMax
       FROM metrics WHERE server_id = ? AND ts >= ? ORDER BY ts ASC`
    )
    .all(serverId, since);
  return downsample(rows);
}

function getSummary(serverIds) {
  let totalServers;
  let runningRows;
  if (serverIds === undefined) {
    ({ c: totalServers } = db.prepare('SELECT COUNT(*) AS c FROM servers').get());
    runningRows = db.prepare("SELECT id FROM servers WHERE status IN ('online', 'starting')").all();
  } else {
    const ids = [...new Set((serverIds || []).filter((id) => Number.isInteger(id) && id > 0))];
    totalServers = ids.length;
    if (!ids.length) {
      runningRows = [];
    } else {
      const placeholders = ids.map(() => '?').join(', ');
      runningRows = db.prepare(
        `SELECT id FROM servers WHERE id IN (${placeholders}) AND status IN ('online', 'starting')`
      ).all(...ids);
    }
  }

  let cpuSum = 0;
  let totalRam = 0;
  let totalPlayers = 0;
  let withMetrics = 0;
  for (const { id } of runningRows) {
    const m = lastMetrics.get(id);
    if (m) {
      cpuSum += m.cpu;
      totalRam += m.ram;
      totalPlayers += m.playersOnline;
      withMetrics++;
    }
  }

  return {
    serversRunning: runningRows.length,
    totalServers,
    avgCpu: withMetrics ? round1(cpuSum / withMetrics) : 0,
    totalRam,
    totalPlayers,
    uptimeSec: Math.round(process.uptime()),
  };
}

// Sample overall container/host CPU usage over ~1 s. Returns a value 0..100.
function sampleCpuPercent() {
  return new Promise((resolve) => {
    const start = os.cpus();
    setTimeout(() => {
      const end = os.cpus();
      let idleDiff = 0;
      let totalDiff = 0;
      for (let i = 0; i < start.length; i++) {
        const s = start[i].times;
        const e = end[i].times;
        let coreTotal = 0;
        for (const key of Object.keys(e)) {
          coreTotal += e[key] - s[key];
        }
        idleDiff += e.idle - s.idle;
        totalDiff += coreTotal;
      }
      const pct = totalDiff > 0 ? Math.round((1 - idleDiff / totalDiff) * 1000) / 10 : 0;
      resolve(Math.max(0, Math.min(100, pct)));
    }, 1000);
  });
}

async function getHostMetrics() {
  const cpuPercent = await sampleCpuPercent();
  const cpuCores = os.cpus().length;
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const memUsed = memTotal - memFree;
  const memUsedPercent = memTotal ? Math.round((memUsed / memTotal) * 1000) / 10 : 0;

  let diskTotal = 0;
  let diskFree = 0;
  try {
    const stat = fs.statfsSync('/');
    diskTotal = stat.blocks * stat.bsize;
    diskFree = stat.bfree * stat.bsize;
  } catch (err) {
    /* ignore — container may restrict statfs */ }

  const diskUsed = diskTotal - diskFree;
  const diskUsedPercent = diskTotal ? Math.round((diskUsed / diskTotal) * 1000) / 10 : 0;

  return {
    cpuCores,
    cpuPercent,
    memTotal,
    memFree,
    memUsed,
    memUsedPercent,
    diskTotal,
    diskFree,
    diskUsed,
    diskUsedPercent,
    uptimeSec: Math.round(os.uptime()),
  };
}

module.exports = { start, stop, tickOnce, getHistory, getSummary, getHostMetrics };
