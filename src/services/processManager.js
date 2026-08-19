// Process manager: runs real Minecraft server JVMs, with a simulation fallback.
// Mode: 'real' when SIMULATION_MODE !== 'true' AND a java binary is available,
// otherwise 'simulation' (staged boot logs, ambient chatter — no processes).
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { db, now } = require('./database');
const serverService = require('./serverService');
const { pick, randInt } = require('../utils/helpers');

const SERVERS_DIR = process.env.SERVERS_DIR || './servers';
const PLAYER_POLL_MS = 20_000;

let io = null;
let mode = 'simulation';
// serverId -> sim: { status, timers:Set<Timeout>, ambientTimer, players:Set<string> }
//           real: { proc, status, playersOnline, playersMax, tps, stopping,
//                   restartPending, exited, killTimers: Timeout[] }
const running = new Map();
let pollTimer = null;

const PLAYER_NAMES = ['Steve', 'Alex', 'Herobrine', 'Notch', 'CreeperHunter', 'DiamondDave', 'Endergirl', 'CraftyMiner', 'BlockBuilder', 'RedstoneRon'];

// Lazy-require: installerService is built by another agent and may be absent.
function getInstaller() {
  try {
    return require('./installerService');
  } catch {
    return null;
  }
}

// --- Mode resolution ---------------------------------------------------------

function probeJava() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    let child;
    try {
      child = spawn('java', ['-version'], { stdio: 'ignore' });
    } catch {
      return done(false);
    }
    child.on('error', () => done(false));
    child.on('exit', (code) => done(code === 0));
  });
}

function init(ioInstance) {
  io = ioInstance;
  // Child processes cannot survive a panel/container restart. Reconcile stale
  // persisted states before accepting power or backup operations.
  const stale = db.prepare("SELECT id FROM servers WHERE status != 'offline'").all();
  for (const server of stale) {
    applyStatus(server.id, null, 'offline');
    log(server.id, 'Panel neu gestartet: Kein verwalteter Server-Prozess gefunden, Status auf offline gesetzt.');
  }
  startPolling();
  if (process.env.SIMULATION_MODE === 'true') {
    mode = 'simulation';
    return;
  }
  // Probe java once; real mode only when the binary actually runs.
  probeJava().then((ok) => {
    mode = ok ? 'real' : 'simulation';
    if (ok) {
      console.log('[processManager] Real mode: java available, servers run as real processes.');
    } else {
      console.warn('[processManager] SIMULATION_MODE=false but no java binary found — falling back to simulation mode.');
    }
  });
}

function getMode() {
  return mode;
}

// --- Shared helpers ------------------------------------------------------------

function emitStatus(serverId, status) {
  if (io) io.to(`server:${serverId}`).emit('server:status', { serverId, status });
}

function log(serverId, line) {
  const ts = now();
  try {
    db.prepare('INSERT INTO logs (server_id, ts, line) VALUES (?, ?, ?)').run(serverId, ts, line);
    // Prune to last 500 lines per server.
    db.prepare(
      'DELETE FROM logs WHERE server_id = ? AND id NOT IN (SELECT id FROM logs WHERE server_id = ? ORDER BY ts DESC, id DESC LIMIT 500)'
    ).run(serverId, serverId);
  } catch {
    // Server row may have been deleted mid-shutdown; ignore.
  }
  if (io) io.to(`server:${serverId}`).emit('log:line', { serverId, ts, line });
}

function applyStatus(serverId, state, status) {
  if (state) state.status = status;
  try {
    serverService.setStatus(serverId, status);
  } catch {
    // Server may have been deleted; ignore.
  }
  emitStatus(serverId, status);
}

function status(serverId) {
  const state = running.get(serverId);
  return state ? state.status : 'offline';
}

// --- Simulation mode -----------------------------------------------------------

function schedule(state, fn, ms) {
  const t = setTimeout(() => {
    state.timers.delete(t);
    fn();
  }, ms);
  state.timers.add(t);
  return t;
}

function ambientLine(state) {
  const roll = Math.random();
  if (roll < 0.3) {
    const name = pick(PLAYER_NAMES);
    if (!state.players.has(name)) {
      state.players.add(name);
      return `${name} joined the game`;
    }
    return `${name} has made the advancement [Stone Age]`;
  }
  if (roll < 0.5) {
    if (state.players.size > 0) {
      const name = pick([...state.players]);
      state.players.delete(name);
      return `${name} left the game`;
    }
    return 'Villager mumbles happily';
  }
  return pick([
    'Saving the game',
    'Saved the game',
    `${pick(PLAYER_NAMES)} was slain by Zombie`,
    `${pick(PLAYER_NAMES)} fell out of the world`,
    'Villager mumbles happily',
    'Herobrine was here...',
    'Creeper hisses in the distance',
  ]);
}

function startAmbient(serverId, state) {
  const tick = () => {
    log(serverId, ambientLine(state));
    state.ambientTimer = setTimeout(tick, randInt(10_000, 20_000));
  };
  state.ambientTimer = setTimeout(tick, randInt(10_000, 20_000));
}

function startSim(serverId) {
  const existing = running.get(serverId);
  if (existing && (existing.status === 'starting' || existing.status === 'online')) {
    return existing.status;
  }
  const server = serverService.getServer(serverId);
  if (!server) throw new Error(`Server ${serverId} not found`);

  const state = { status: 'starting', timers: new Set(), ambientTimer: null, players: new Set() };
  running.set(serverId, state);
  applyStatus(serverId, state, 'starting');

  const bootSequence = [
    [0, `Starting minecraft server version ${server.version}`],
    [400, 'Loading properties'],
    [800, 'Default game type: SURVIVAL'],
    [1300, 'Preparing spawn area: 34%'],
    [1900, 'Preparing spawn area: 73%'],
    [2400, 'Preparing level "world"'],
    [3000, 'Done (4.2s)! For help, type "help"'],
  ];
  for (const [delay, line] of bootSequence) {
    schedule(state, () => log(serverId, line), delay);
  }
  schedule(state, () => {
    applyStatus(serverId, state, 'online');
    log(serverId, `Server is now online on port ${server.port}`);
    startAmbient(serverId, state);
  }, 3100);

  return 'starting';
}

function stopSim(serverId) {
  const state = running.get(serverId);
  if (!state) return 'offline';
  if (state.status === 'stopping') return 'stopping';

  for (const t of state.timers) clearTimeout(t);
  state.timers.clear();
  if (state.ambientTimer) {
    clearTimeout(state.ambientTimer);
    state.ambientTimer = null;
  }

  applyStatus(serverId, state, 'stopping');
  log(serverId, 'Stopping the server');

  schedule(state, () => {
    applyStatus(serverId, state, 'offline');
    log(serverId, 'Server stopped');
    running.delete(serverId);
  }, 1200);

  return 'stopping';
}

function restartSim(serverId) {
  const state = running.get(serverId);
  if (state && state.status !== 'offline') {
    stopSim(serverId);
    // Boot again shortly after the simulated shutdown completes.
    const t = setTimeout(() => {
      try {
        startSim(serverId);
      } catch {
        // Server deleted in the meantime; ignore.
      }
    }, 1600);
    if (state) state.timers.add(t); // still tracked so delete/shutdown can cancel
    return 'stopping';
  }
  return startSim(serverId);
}

function cleanupSim(serverId) {
  const state = running.get(serverId);
  if (!state) return;
  for (const t of state.timers) clearTimeout(t);
  state.timers.clear();
  if (state.ambientTimer) clearTimeout(state.ambientTimer);
  running.delete(serverId);
}

// --- Real mode -------------------------------------------------------------------

// Strip ANSI codes and MC's own [HH:MM:SS] timestamp (we track ts ourselves).
function cleanLine(line) {
  return String(line)
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\r/g, '')
    .replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, '');
}

function handleLine(serverId, state, rawLine) {
  const line = cleanLine(rawLine);
  if (!line) return;
  log(serverId, line);

  if (/\bDone \([\d.]+s\)!/.test(line)) {
    applyStatus(serverId, state, 'online');
  } else if (line.includes('Stopping the server')) {
    applyStatus(serverId, state, 'stopping');
  }

  const listMatch = line.match(/There are (\d+) of a max of (\d+) players online:?\s*(.*)$/);
  if (listMatch) {
    state.playersOnline = parseInt(listMatch[1], 10);
    state.playersMax = parseInt(listMatch[2], 10);
    state.playerNames = listMatch[3]
      ? listMatch[3].split(',').map((name) => name.trim()).filter(Boolean)
      : [];
  }
  const tpsMatch = line.match(/TPS from last 1m.*?: \*?([\d.]+)/);
  if (tpsMatch) {
    state.tps = parseFloat(tpsMatch[1]);
  }
}

// Split a stream into lines and feed each through handleLine.
function attachLinePipe(serverId, state, stream) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      handleLine(serverId, state, buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  });
  stream.on('end', () => {
    if (buf.trim()) handleLine(serverId, state, buf);
    buf = '';
  });
}

function buildJavaArgs(server, runConfig) {
  const ramMb = server.ramMb || 1024;
  const cpuCores = server.cpuCores || 1;
  const args = [
    `-XX:ActiveProcessorCount=${cpuCores}`,
    `-Xmx${ramMb}M`,
    `-Xms${Math.min(ramMb, 1024)}M`,
  ];
  if (runConfig.type === 'jar') {
    args.push('-jar', runConfig.jar, 'nogui');
  } else {
    // Loader-style launch: args files relative to workDir.
    const jvmArgsFile = path.join(runConfig.workDir, 'user_jvm_args.txt');
    if (!fs.existsSync(jvmArgsFile)) {
      try {
        fs.writeFileSync(jvmArgsFile, '# JVM args for this server (one per line)\n');
      } catch {
        // read-only dir; java will fail with a clear log line
      }
    }
    args.push('@user_jvm_args.txt', `@${runConfig.argsFile}`, 'nogui');
  }
  return args;
}

function parseCpuList(value) {
  const ids = [];
  for (const part of String(value || '').trim().split(',')) {
    const match = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!match) continue;
    const start = Number(match[1]);
    const end = match[2] == null ? start : Number(match[2]);
    if (end < start) continue;
    for (let id = start; id <= end; id += 1) ids.push(id);
  }
  return [...new Set(ids)];
}

function allowedCpuIds() {
  try {
    const statusFile = fs.readFileSync('/proc/self/status', 'utf8');
    const match = statusFile.match(/^Cpus_allowed_list:\s*(.+)$/m);
    return match ? parseCpuList(match[1]) : [];
  } catch {
    return [];
  }
}

function startReal(serverId) {
  const existing = running.get(serverId);
  if (existing && existing.status !== 'offline') {
    return existing.status;
  }
  const server = serverService.getServer(serverId);
  if (!server) throw new Error(`Server ${serverId} not found`);

  const installer = getInstaller();
  const runConfig = installer ? installer.getRunConfig(serverId) : null;
  if (!runConfig) {
    // Safety net: routes pre-check installation before calling start().
    applyStatus(serverId, null, 'offline');
    throw new Error('Server ist nicht installiert');
  }

  const javaArgs = buildJavaArgs(server, runConfig);
  const selectedCpus = allowedCpuIds().slice(0, server.cpuCores);
  const useTaskset = selectedCpus.length > 0 && fs.existsSync('/usr/bin/taskset');
  const command = useTaskset ? '/usr/bin/taskset' : 'java';
  const args = useTaskset
    ? ['-c', selectedCpus.join(','), 'java', ...javaArgs]
    : javaArgs;
  const proc = spawn(command, args, { cwd: runConfig.workDir });
  const state = {
    proc,
    status: 'starting',
    playersOnline: 0,
    playersMax: 20,
    playerNames: [],
    tps: 20,
    stopping: false,
    restartPending: false,
    exited: false,
    killTimers: [],
  };
  running.set(serverId, state);
  applyStatus(serverId, state, 'starting');
  log(serverId, `Ressourcen: ${server.cpuCores} CPU / ${server.ramMb} MB RAM`);
  log(serverId, `Starte Server-Prozess (java, PID ${proc.pid == null ? '?' : proc.pid}) ...`);

  attachLinePipe(serverId, state, proc.stdout);
  attachLinePipe(serverId, state, proc.stderr);

  const onExit = (code, signal) => {
    if (state.exited) return;
    state.exited = true;
    for (const t of state.killTimers) clearTimeout(t);
    state.killTimers = [];
    const unexpected = !state.stopping;
    log(serverId, `Server-Prozess beendet (Exit-Code ${code == null ? signal || 'unbekannt' : code})`);
    if (unexpected) log(serverId, '⚠ Server unerwartet beendet — prüfe die Logs.');
    applyStatus(serverId, state, 'offline');
    running.delete(serverId);
    if (state.restartPending) {
      state.restartPending = false;
      setTimeout(() => {
        try {
          startReal(serverId);
        } catch {
          // Server deleted or install removed in the meantime; ignore.
        }
      }, 500);
    }
  };
  proc.on('error', (err) => {
    log(serverId, `Prozessfehler: ${err.message}`);
    onExit(null, null);
  });
  proc.on('exit', onExit);

  return 'starting';
}

function stopReal(serverId) {
  const state = running.get(serverId);
  if (!state || !state.proc) {
    applyStatus(serverId, null, 'offline');
    log(serverId, 'Kein laufender Server-Prozess gefunden, Status auf offline korrigiert.');
    return 'offline';
  }
  if (state.stopping) return 'stopping';

  state.stopping = true;
  applyStatus(serverId, state, 'stopping');
  log(serverId, 'Stopping the server');
  try {
    state.proc.stdin.write('stop\n'); // graceful MC shutdown
  } catch {
    // stdin already closed; escalation timers below handle the rest
  }
  state.killTimers.push(
    setTimeout(() => {
      try {
        state.proc.kill('SIGTERM');
      } catch {
        // already gone
      }
    }, 45_000),
    setTimeout(() => {
      try {
        state.proc.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, 55_000)
  );
  return 'stopping';
}

function restartReal(serverId) {
  const state = running.get(serverId);
  if (state && state.proc && state.status !== 'offline') {
    state.restartPending = true; // startReal() is chained from the exit handler
    return stopReal(serverId);
  }
  return startReal(serverId);
}

function cleanupReal(serverId) {
  const state = running.get(serverId);
  if (state && state.proc) {
    state.restartPending = false;
    state.stopping = true;
    for (const t of state.killTimers) clearTimeout(t);
    state.killTimers = [];
    try {
      state.proc.stdin.write('stop\n');
    } catch {
      // ignore
    }
    // Escalation chain (unref'd so an exiting panel is never held back).
    const proc = state.proc;
    setTimeout(() => {
      try {
        proc.kill('SIGTERM');
      } catch {
        // already gone
      }
    }, 2_000).unref();
    setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, 5_000).unref();
  }
  running.delete(serverId);
  // Best-effort removal of the server's files on disk.
  try {
    fs.rmSync(path.join(SERVERS_DIR, String(serverId)), { recursive: true, force: true });
  } catch {
    // ignore fs errors
  }
}

// Every 20s: poll online real servers for player counts (and TPS on Paper).
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (mode !== 'real') return;
    for (const [id, state] of running) {
      if (!state.proc || state.exited || state.status !== 'online') continue;
      try {
        state.proc.stdin.write('list\n');
        const server = serverService.getServer(id);
        if (server && server.loader === 'paper') {
          state.proc.stdin.write('tps\n');
        }
      } catch {
        // stdin closed; exit handler will clean up
      }
    }
  }, PLAYER_POLL_MS);
}

// --- Public API (mode dispatch) ---------------------------------------------------

function start(serverId) {
  return mode === 'real' ? startReal(serverId) : startSim(serverId);
}

function stop(serverId) {
  return mode === 'real' ? stopReal(serverId) : stopSim(serverId);
}

function restart(serverId) {
  return mode === 'real' ? restartReal(serverId) : restartSim(serverId);
}

// Send a console command to a running server. Sanitized, real mode only.
function sendCommand(serverId, command) {
  const cmd = String(command == null ? '' : command)
    .replace(/[\x00-\x1f\x7f]/g, '') // strip control chars (incl. newlines)
    .trim()
    .slice(0, 200);
  if (!cmd) return false;

  const state = running.get(serverId);
  if (mode !== 'real') {
    // Simulation: no stdin — echo into the log so the demo console stays usable.
    if (!state || state.status !== 'online') return false;
    log(serverId, `> ${cmd}`);
    return true;
  }
  if (!state || !state.proc || state.exited || state.status !== 'online') return false;
  try {
    state.proc.stdin.write(cmd + '\n');
    return true;
  } catch {
    return false;
  }
}

// Runtime info for metricsService; null when no live real process exists.
function getRuntimeInfo(serverId) {
  const state = running.get(serverId);
  if (!state || !state.proc || state.exited) return null;
  return {
    pid: state.proc.pid,
    playersOnline: state.playersOnline,
    playersMax: state.playersMax,
    playerNames: state.playerNames || [],
    tps: state.tps,
  };
}

// Called before a server is deleted: kill the process tree, drop map entry,
// and remove the server directory from disk (best effort).
function cleanup(serverId) {
  if (mode === 'real') {
    cleanupReal(serverId);
  } else {
    cleanupSim(serverId);
  }
}

// Synchronous-ish teardown on app shutdown: ask nicely, SIGTERM shortly after.
function shutdownAll() {
  for (const [id, state] of [...running]) {
    if (state.proc) {
      state.restartPending = false;
      state.stopping = true;
      for (const t of state.killTimers) clearTimeout(t);
      state.killTimers = [];
      try {
        state.proc.stdin.write('stop\n');
      } catch {
        // ignore
      }
      const proc = state.proc;
      setTimeout(() => {
        try {
          proc.kill('SIGTERM');
        } catch {
          // already gone
        }
      }, 3_000).unref();
    } else {
      cleanupSim(id);
    }
  }
  running.clear();
}

module.exports = {
  init,
  getMode,
  start,
  stop,
  restart,
  sendCommand,
  getRuntimeInfo,
  cleanup,
  shutdownAll,
  status,
  log,
  buildJavaArgs,
  parseCpuList,
};
