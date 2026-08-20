'use strict';

const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { EventEmitter } = require('events');
const { createDockerClient } = require('./dockerEngineClient');

const MANAGED = 'io.mc-panel.managed';
const INSTANCE = 'io.mc-panel.instance';
const SERVER_ID = 'io.mc-panel.server-id';
const SPEC = 'io.mc-panel.spec-sha256';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function calculateStats(stats, cpuCores) {
  const cpu = stats.cpu_stats || {};
  const previous = stats.precpu_stats || {};
  const cpuDelta = Number(cpu.cpu_usage && cpu.cpu_usage.total_usage || 0) - Number(previous.cpu_usage && previous.cpu_usage.total_usage || 0);
  const systemDelta = Number(cpu.system_cpu_usage || 0) - Number(previous.system_cpu_usage || 0);
  const online = Number(cpu.online_cpus || (cpu.cpu_usage && cpu.cpu_usage.percpu_usage || []).length || 1);
  const hostPercent = systemDelta > 0 && cpuDelta >= 0 ? (cpuDelta / systemDelta) * online * 100 : 0;
  const memory = stats.memory_stats || {};
  const cache = Number(memory.stats && (memory.stats.inactive_file ?? memory.stats.cache) || 0);
  return {
    cpu: clamp(hostPercent / Math.max(1, Number(cpuCores) || 1), 0, 100),
    memoryBytes: Math.max(0, Number(memory.usage || 0) - cache),
  };
}

function safeInstance(value) {
  const normalized = String(value || '').toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized) throw new Error('PANEL_INSTANCE_ID konnte nicht bestimmt werden');
  return normalized.slice(0, 40);
}

function generatedInstance(project, mountSource) {
  const prefix = safeInstance(project || 'panel').slice(0, 29);
  const suffix = crypto.createHash('sha256').update(String(mountSource)).digest('hex').slice(0, 10);
  return `${prefix}-${suffix}`;
}

function createDockerRuntime(options = {}) {
  const events = new EventEmitter();
  const client = options.client || createDockerClient({ socketPath: options.socketPath || process.env.DOCKER_SOCKET || '/var/run/docker.sock' });
  const serversDir = path.resolve(options.serversDir || process.env.SERVERS_DIR || './servers');
  const panelRef = options.panelRef || process.env.PANEL_CONTAINER_REF || process.env.HOSTNAME;
  const handles = new Map();
  const operations = new Map();
  let panelImage = null;
  let mountSource = null;
  let instanceId = null;
  let reconcileTimer = null;
  let closed = false;

  function filters() {
    return { label: [`${MANAGED}=true`, `${INSTANCE}=${instanceId}`] };
  }

  function verify(container, serverId) {
    const labels = container.Config && container.Config.Labels || {};
    if (labels[MANAGED] !== 'true' || labels[INSTANCE] !== instanceId || String(labels[SERVER_ID]) !== String(serverId)) {
      throw new Error('Docker-Container gehört nicht zu diesem Panel/Server');
    }
    const expected = path.posix.join(mountSource.replace(/\\/g, '/'), String(serverId));
    const serverMount = (container.Mounts || []).find((entry) => entry.Destination === '/server');
    const actual = serverMount && String(serverMount.Source || '').replace(/\\/g, '/').replace(/\/$/, '');
    if (!serverMount || serverMount.RW === false || actual !== expected) {
      throw new Error('Docker-Container verwendet nicht das erwartete Serververzeichnis');
    }
  }

  async function discoverContext() {
    if (!panelRef) throw new Error('Panel-Containerreferenz fehlt (HOSTNAME/PANEL_CONTAINER_REF)');
    const panel = await client.inspectContainer(panelRef);
    panelImage = process.env.MC_RUNTIME_IMAGE || panel.Image;
    const mount = (panel.Mounts || []).find((entry) => path.resolve(entry.Destination) === serversDir && entry.RW !== false);
    if (!mount || !['volume', 'bind'].includes(String(mount.Type).toLowerCase()) || !mount.Source) {
      throw new Error(`Schreibbarer Docker-Mount für SERVERS_DIR ${serversDir} wurde nicht gefunden`);
    }
    mountSource = mount.Source;
    const project = panel.Config && panel.Config.Labels && panel.Config.Labels['com.docker.compose.project'];
    instanceId = options.instanceId || process.env.PANEL_INSTANCE_ID
      ? safeInstance(options.instanceId || process.env.PANEL_INSTANCE_ID)
      : generatedInstance(project, mountSource);
  }

  function containerName(serverId) {
    return `mc-panel-${instanceId}-server-${serverId}`;
  }

  function createPayload(spec) {
    const portKey = `${spec.server.port}/tcp`;
    const bindIp = String(process.env.MC_BIND_IP || '0.0.0.0').trim();
    if (!net.isIP(bindIp)) throw new Error(`Ungültige MC_BIND_IP: ${bindIp}`);
    const memoryLimit = (Number(spec.server.ramMb) + 512) * 1024 * 1024;
    const specHash = crypto.createHash('sha256').update(JSON.stringify({
      image: panelImage,
      serverId: spec.server.id,
      port: spec.server.port,
      ramMb: spec.server.ramMb,
      cpuCores: spec.server.cpuCores,
      javaArgs: spec.javaArgs,
      javaBinary: spec.javaBinary,
      mountSource,
      bindIp,
      healthcheckVersion: 1,
    })).digest('hex');
    return {
      Hostname: `mc-server-${spec.server.id}`,
      User: 'node',
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      OpenStdin: true,
      StdinOnce: false,
      Image: panelImage,
      Entrypoint: [spec.javaBinary || 'java'],
      Cmd: spec.javaArgs,
      WorkingDir: '/server',
      ExposedPorts: { [portKey]: {} },
      Labels: {
        [MANAGED]: 'true',
        [INSTANCE]: instanceId,
        [SERVER_ID]: String(spec.server.id),
        [SPEC]: specHash,
      },
      Healthcheck: {
        Test: ['CMD', 'node', '-e', `const s=require('net').connect(${Number(spec.server.port)},'127.0.0.1',()=>process.exit(0));s.setTimeout(2000,()=>process.exit(1));s.on('error',()=>process.exit(1))`],
        Interval: 5_000_000_000,
        Timeout: 3_000_000_000,
        StartPeriod: 10_000_000_000,
        Retries: 12,
      },
      StopSignal: 'SIGTERM',
      StopTimeout: 55,
      HostConfig: {
        Mounts: [{ Type: 'bind', Source: path.posix.join(mountSource.replace(/\\/g, '/'), String(spec.server.id)), Target: '/server', ReadOnly: false }],
        PortBindings: { [portKey]: [{ HostIp: bindIp, HostPort: String(spec.server.port) }] },
        Memory: memoryLimit,
        MemorySwap: memoryLimit,
        NanoCpus: Number(spec.server.cpuCores) * 1_000_000_000,
        PidsLimit: 4096,
        Init: true,
        AutoRemove: false,
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Tmpfs: { '/tmp': 'rw,exec,nosuid,nodev,size=268435456' },
        NetworkMode: 'bridge',
        RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
        LogConfig: { Type: 'local', Config: { 'max-size': '20m', 'max-file': '3' } },
      },
    };
  }

  function consumeLines(serverId, handle, chunk) {
    handle.buffer += chunk.toString('utf8');
    let index;
    while ((index = handle.buffer.indexOf('\n')) >= 0) {
      let line = handle.buffer.slice(0, index).replace(/\r$/, '');
      handle.buffer = handle.buffer.slice(index + 1);
      if (handle.recent.has(line)) continue;
      handle.recent.add(line);
      handle.recentOrder.push(line);
      if (handle.recentOrder.length > 200) handle.recent.delete(handle.recentOrder.shift());
      line = line.replace(/^\d{4}-\d{2}-\d{2}T\S+\s/, '');
      if (/Done \([^)]*\)! For help/.test(line)) handle.lifecycleStatus = 'online';
      if (line) events.emit('line', serverId, line);
    }
  }

  async function connectStreams(serverId, containerId, since, lifecycleStatus, startedAt) {
    const previous = handles.get(serverId);
    if (previous) {
      if (previous.logStream) previous.logStream.close();
      if (previous.stdin) previous.stdin.destroy();
    }
    const handle = {
      id: containerId,
      buffer: '',
      stdin: null,
      logStream: null,
      running: true,
      recent: previous && previous.recent || new Set(),
      recentOrder: previous && previous.recentOrder || [],
      lifecycleStatus: lifecycleStatus || previous && previous.lifecycleStatus || 'starting',
      startedAt: startedAt || previous && previous.startedAt || null,
    };
    handles.set(serverId, handle);
    const query = `follow=1&stdout=1&stderr=1&timestamps=1&since=${encodeURIComponent(since || 0)}`;
    handle.logStream = await client.logs(containerId, query, (chunk) => consumeLines(serverId, handle, chunk));
    const currentStream = handle.logStream;
    currentStream.response.on('close', () => {
      if (handle.logStream === currentStream) handle.logStream = null;
    });
    handle.stdin = await client.attach(containerId);
    handle.stdin.on('error', () => {});
    return handle;
  }

  async function managedContainers() {
    const summaries = await client.listContainers(filters());
    const result = [];
    for (const summary of summaries || []) {
      const inspected = await client.inspectContainer(summary.Id);
      const serverId = Number(inspected.Config && inspected.Config.Labels && inspected.Config.Labels[SERVER_ID]);
      if (Number.isInteger(serverId) && serverId > 0) result.push({ serverId, inspected });
    }
    return result;
  }

  async function ensureRestartPolicy(container) {
    const policy = container.HostConfig && container.HostConfig.RestartPolicy && container.HostConfig.RestartPolicy.Name;
    if (policy && policy !== 'unless-stopped') {
      await client.updateContainer(container.Id, { RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 } });
    }
  }

  async function reconcile() {
    if (closed) return [];
    const found = await managedContainers();
    const seen = new Set();
    for (const { serverId, inspected } of found) {
      seen.add(serverId);
      if (operations.has(serverId)) continue;
      verify(inspected, serverId);
      await ensureRestartPolicy(inspected);
      const isRunning = Boolean(inspected.State && inspected.State.Running);
      const handle = handles.get(serverId);
      const startedAt = String(inspected.State && inspected.State.StartedAt || '');
      const sameRun = Boolean(handle && handle.startedAt === startedAt);
      const healthy = inspected.State && inspected.State.Health && inspected.State.Health.Status === 'healthy';
      if (isRunning && (!handle || !handle.running || !handle.logStream || !sameRun)) {
        let status = healthy ? 'online' : sameRun && handle.lifecycleStatus || 'starting';
        if (!sameRun) {
          status = 'starting';
          const startedEpoch = Math.floor(new Date(startedAt).getTime() / 1000) || 0;
          const history = await client.logsText(inspected.Id, `stdout=1&stderr=1&timestamps=1&tail=200&since=${startedEpoch}`);
          if (/Done \([^)]*\)! For help/.test(String(history || ''))) status = 'online';
          if (healthy) status = 'online';
        }
        const since = Math.max(0, Math.floor(Date.now() / 1000) - 2);
        await connectStreams(serverId, inspected.Id, since, status, startedAt);
        events.emit('state', serverId, status, inspected.State);
      } else if (isRunning && healthy && handle.lifecycleStatus !== 'online') {
        handle.lifecycleStatus = 'online';
        events.emit('state', serverId, 'online', inspected.State);
      } else if (!isRunning && handle && handle.running) {
        handle.running = false;
        events.emit('state', serverId, 'offline', inspected.State);
      } else if (!handle) {
        handles.set(serverId, { id: inspected.Id, buffer: '', stdin: null, logStream: null, running: false, recent: new Set(), recentOrder: [], lifecycleStatus: 'starting', startedAt });
        events.emit('state', serverId, 'offline', inspected.State);
      }
    }
    for (const [serverId, handle] of handles) {
      if (!seen.has(serverId) && handle.running) {
        handle.running = false;
        events.emit('state', serverId, 'offline', null);
      }
    }
    return found;
  }

  async function init() {
    await client.init();
    await discoverContext();
    const found = await reconcile();
    reconcileTimer = setInterval(() => reconcile().catch((error) => events.emit('error', error)), 10_000);
    reconcileTimer.unref();
    return found;
  }

  async function find(serverId) {
    const matches = (await managedContainers()).filter((entry) => entry.serverId === Number(serverId));
    if (matches.length > 1) throw new Error(`Mehrere Docker-Container für Server ${serverId} gefunden`);
    return matches[0] || null;
  }

  function serialize(serverId, operation) {
    const key = Number(serverId);
    const previous = operations.get(key) || Promise.resolve();
    const current = previous.then(operation, operation);
    operations.set(key, current);
    current.finally(() => {
      if (operations.get(key) === current) operations.delete(key);
    }).catch(() => {});
    return current;
  }

  async function startUnlocked(spec) {
    let found = await find(spec.server.id);
    const payload = createPayload(spec);
    if (found) {
      const labels = found.inspected.Config && found.inspected.Config.Labels || {};
      if (labels[SPEC] !== payload.Labels[SPEC]) {
        if (found.inspected.State && found.inspected.State.Running) {
          throw new Error('Container-Konfiguration weicht ab; Server zuerst stoppen');
        }
        verify(found.inspected, spec.server.id);
        await client.removeContainer(found.inspected.Id, false);
        handles.delete(Number(spec.server.id));
        found = null;
      }
    }
    if (!found) {
      const created = await client.createContainer(containerName(spec.server.id), payload);
      found = { serverId: spec.server.id, inspected: await client.inspectContainer(created.Id) };
    }
    verify(found.inspected, spec.server.id);
    await ensureRestartPolicy(found.inspected);
    if (!(found.inspected.State && found.inspected.State.Running)) await client.startContainer(found.inspected.Id);
    const inspected = await client.inspectContainer(found.inspected.Id);
    const since = Math.floor(new Date(inspected.State.StartedAt).getTime() / 1000) || Math.floor(Date.now() / 1000) - 2;
    await connectStreams(spec.server.id, inspected.Id, since, 'starting', String(inspected.State.StartedAt || ''));
    return { id: inspected.Id, status: 'starting' };
  }

  async function stopContainerGracefully(found, serverId) {
    if (!(found.inspected.State && found.inspected.State.Running)) return;
    let policyDisabled = false;
    try {
      await client.updateContainer(found.inspected.Id, { RestartPolicy: { Name: 'no', MaximumRetryCount: 0 } });
      policyDisabled = true;
      let handle = handles.get(Number(serverId));
      if (!handle || !handle.stdin || handle.stdin.destroyed) {
        handle = await connectStreams(Number(serverId), found.inspected.Id, Math.max(0, Math.floor(Date.now() / 1000) - 2));
      }
      handle.stdin.write('stop\n');
      await client.waitContainer(found.inspected.Id, 45);
    } catch {
      await client.stopContainer(found.inspected.Id, 10);
    } finally {
      if (policyDisabled) {
        try {
          await client.updateContainer(found.inspected.Id, { RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 } });
        } catch (error) {
          events.emit('error', error);
        }
      }
    }
  }

  async function stopUnlocked(serverId) {
    const found = await find(serverId);
    if (!found) return 'offline';
    verify(found.inspected, serverId);
    await stopContainerGracefully(found, serverId);
    const handle = handles.get(Number(serverId));
    if (handle) handle.running = false;
    return 'offline';
  }

  async function restartUnlocked(serverId) {
    const found = await find(serverId);
    if (!found) throw new Error('Docker-Container wurde noch nicht erstellt');
    verify(found.inspected, serverId);
    await stopContainerGracefully(found, serverId);
    await client.startContainer(found.inspected.Id);
    const inspected = await client.inspectContainer(found.inspected.Id);
    const since = Math.floor(new Date(inspected.State.StartedAt).getTime() / 1000) || Math.floor(Date.now() / 1000) - 2;
    await connectStreams(Number(serverId), inspected.Id, since, 'starting', String(inspected.State.StartedAt || ''));
    return 'starting';
  }

  async function removeUnlocked(serverId) {
    const found = await find(serverId);
    if (!found) return;
    verify(found.inspected, serverId);
    if (found.inspected.State && found.inspected.State.Running) await stopContainerGracefully(found, serverId);
    await client.removeContainer(found.inspected.Id, false);
    const handle = handles.get(Number(serverId));
    if (handle) {
      if (handle.logStream) handle.logStream.close();
      if (handle.stdin) handle.stdin.destroy();
    }
    handles.delete(Number(serverId));
  }

  async function command(serverId, command) {
    let handle = handles.get(Number(serverId));
    if (!handle || !handle.stdin || handle.stdin.destroyed) {
      const found = await find(serverId);
      if (!found || !(found.inspected.State && found.inspected.State.Running)) return false;
      handle = await connectStreams(Number(serverId), found.inspected.Id, Math.floor(Date.now() / 1000));
    }
    return handle.stdin.write(`${command}\n`);
  }

  async function sample(serverId, cpuCores) {
    const handle = handles.get(Number(serverId));
    if (!handle || !handle.running) return null;
    return calculateStats(await client.stats(handle.id), cpuCores);
  }

  function shutdown() {
    closed = true;
    if (reconcileTimer) clearInterval(reconcileTimer);
    for (const handle of handles.values()) {
      if (handle.logStream) handle.logStream.close();
      if (handle.stdin) handle.stdin.destroy();
    }
    handles.clear();
    operations.clear();
  }

  const start = (spec) => serialize(spec.server.id, () => startUnlocked(spec));
  const stop = (serverId) => serialize(serverId, () => stopUnlocked(serverId));
  const restart = (serverId) => serialize(serverId, () => restartUnlocked(serverId));
  const remove = (serverId) => serialize(serverId, () => removeUnlocked(serverId));

  return Object.assign(events, { init, reconcile, start, stop, restart, remove, command, sample, shutdown, handles, createPayload });
}

module.exports = { createDockerRuntime, calculateStats, safeInstance, generatedInstance };
