'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { once, EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { createDockerClient } = require('../../src/services/dockerEngineClient');
const { createDockerRuntime, calculateStats, generatedInstance } = require('../../src/services/dockerRuntimeService');
const { javaBinaryForVersion } = require('../../src/services/javaRuntime');
const { withServerOperation } = require('../../src/services/serverOperationLock');

test('Docker stats are normalized to assigned CPU cores and exclude cache', () => {
  const result = calculateStats({
    cpu_stats: { cpu_usage: { total_usage: 1100, percpu_usage: [1, 2, 3, 4] }, system_cpu_usage: 11_000, online_cpus: 4 },
    precpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 10_000 },
    memory_stats: { usage: 1000, stats: { inactive_file: 100 } },
  }, 2);
  assert.equal(result.cpu, 20);
  assert.equal(result.memoryBytes, 900);
});

test('Docker client negotiates API version and sends JSON payloads', async (t) => {
  const seen = [];
  const daemon = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8') });
      if (req.url === '/_ping') { res.end('OK'); return; }
      if (req.url === '/version') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ApiVersion: '1.51' })); return; }
      if (req.url.startsWith('/v1.51/containers/create')) {
        res.statusCode = 201;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ Id: 'container-1' }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ message: 'not found' }));
    });
  });
  daemon.listen(0, '127.0.0.1');
  await once(daemon, 'listening');
  t.after(() => daemon.close());
  const client = createDockerClient({ socketPath: null, host: '127.0.0.1', port: daemon.address().port });
  await client.init();
  const created = await client.createContainer('mc test', { Image: 'image-1' });
  assert.equal(created.Id, 'container-1');
  assert.equal(seen[2].method, 'POST');
  assert.match(seen[2].url, /name=mc%20test/);
  assert.deepEqual(JSON.parse(seen[2].body), { Image: 'image-1' });
});

test('Docker log stream handshake has a bounded timeout', async (t) => {
  const daemon = http.createServer((req, res) => {
    if (req.url === '/_ping') { res.end('OK'); return; }
    if (req.url === '/version') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ApiVersion: '1.51' }));
    }
    // Intentionally leave the log-stream handshake unanswered.
  });
  daemon.listen(0, '127.0.0.1');
  await once(daemon, 'listening');
  t.after(() => {
    daemon.closeAllConnections();
    daemon.close();
  });
  const client = createDockerClient({ socketPath: null, host: '127.0.0.1', port: daemon.address().port, timeoutMs: 50 });
  await client.init();
  await assert.rejects(client.logs('container-1', 'follow=1', () => {}), /handshake timed out/);
});

test('runtime payload isolates one server directory and applies cgroup limits', async () => {
  const panel = {
    Image: 'sha256:panel-image',
    Config: { Labels: { 'com.docker.compose.project': 'panel-project' } },
    Mounts: [{ Type: 'volume', Source: '/var/lib/docker/volumes/panel/_data', Destination: '/app/servers', RW: true }],
  };
  const client = {
    init: async () => ({}),
    inspectContainer: async () => panel,
    listContainers: async () => [],
  };
  const runtime = createDockerRuntime({ client, panelRef: 'panel', serversDir: '/app/servers' });
  await runtime.init();
  const payload = runtime.createPayload({
    server: { id: 12, port: 25567, ramMb: 4096, cpuCores: 2 },
    javaBinary: '/usr/lib/jvm/java-21-openjdk-amd64/bin/java',
    javaArgs: ['-Xmx4096M', '-jar', 'server.jar', 'nogui'],
  });
  assert.equal(payload.HostConfig.Mounts[0].Source, '/var/lib/docker/volumes/panel/_data/12');
  assert.equal(payload.HostConfig.Mounts[0].Target, '/server');
  assert.equal(payload.HostConfig.Memory, 4608 * 1024 * 1024);
  assert.equal(payload.HostConfig.NanoCpus, 2_000_000_000);
  assert.equal(payload.HostConfig.CapDrop[0], 'ALL');
  assert.match(payload.HostConfig.Tmpfs['/tmp'], /exec/);
  assert.equal(payload.HostConfig.PortBindings['25567/tcp'][0].HostPort, '25567');
  assert.equal(payload.Entrypoint[0], '/usr/lib/jvm/java-21-openjdk-amd64/bin/java');
  assert.equal(payload.Healthcheck.Test[0], 'CMD');
  runtime.shutdown();
});

test('Java runtime selection matches supported Minecraft generations', () => {
  assert.equal(javaBinaryForVersion('1.17.1'), '/opt/java/17/bin/java');
  assert.equal(javaBinaryForVersion('1.20.4'), '/opt/java/17/bin/java');
  assert.equal(javaBinaryForVersion('1.20.5'), '/opt/java/21/bin/java');
  assert.equal(javaBinaryForVersion('1.21.8'), '/opt/java/21/bin/java');
  assert.equal(javaBinaryForVersion('26.2'), '/opt/java/25/bin/java');
  assert.throws(() => javaBinaryForVersion('1.16.5'), /nicht unterstützt/);
});

test('generated instance identity preserves a volume hash suffix', () => {
  const project = 'a-very-long-compose-project-name-that-shares-a-prefix-with-others';
  const first = generatedInstance(project, '/volumes/first');
  const second = generatedInstance(project, '/volumes/second');
  assert.equal(first.length, 40);
  assert.notEqual(first, second);
  assert.match(first, /-[a-f0-9]{10}$/);
});

test('runtime rejects a labeled container mounted from another panel directory', async () => {
  const panel = {
    Image: 'sha256:panel-image',
    Config: { Labels: { 'com.docker.compose.project': 'panel-project' } },
    Mounts: [{ Type: 'volume', Source: '/volumes/current', Destination: '/app/servers', RW: true }],
  };
  const foreign = {
    Id: 'foreign',
    Config: { Labels: {
      'io.mc-panel.managed': 'true',
      'io.mc-panel.instance': 'test-instance',
      'io.mc-panel.server-id': '7',
    } },
    Mounts: [{ Type: 'bind', Source: '/volumes/other/7', Destination: '/server', RW: true }],
    State: { Running: false },
  };
  const client = {
    init: async () => ({}),
    inspectContainer: async (id) => id === 'panel' ? panel : foreign,
    listContainers: async () => [{ Id: 'foreign' }],
  };
  const runtime = createDockerRuntime({ client, panelRef: 'panel', serversDir: '/app/servers', instanceId: 'test-instance' });
  await assert.rejects(runtime.init(), /erwartete Serververzeichnis/);
  runtime.shutdown();
});

test('concurrent starts are serialized and create only one container', async () => {
  const panel = {
    Image: 'sha256:panel-image',
    Config: { Labels: { 'com.docker.compose.project': 'panel-project' } },
    Mounts: [{ Type: 'volume', Source: '/volumes/current', Destination: '/app/servers', RW: true }],
  };
  let child = null;
  let creates = 0;
  const client = {
    init: async () => ({}),
    inspectContainer: async (id) => id === 'panel' ? panel : child,
    listContainers: async () => child ? [{ Id: child.Id }] : [],
    createContainer: async (_name, payload) => {
      creates += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      child = {
        Id: 'child-1',
        Config: { Labels: payload.Labels },
        Mounts: [{ Type: 'bind', Source: '/volumes/current/8', Destination: '/server', RW: true }],
        State: { Running: false, StartedAt: '' },
      };
      return { Id: child.Id };
    },
    startContainer: async () => {
      child.State = { Running: true, StartedAt: new Date().toISOString() };
    },
    logs: async () => {
      const response = new EventEmitter();
      return { response, close() { response.emit('close'); } };
    },
    attach: async () => new PassThrough(),
  };
  const runtime = createDockerRuntime({ client, panelRef: 'panel', serversDir: '/app/servers', instanceId: 'test-instance' });
  await runtime.init();
  const spec = {
    server: { id: 8, port: 25568, ramMb: 2048, cpuCores: 1 },
    javaBinary: '/opt/java/21/bin/java',
    javaArgs: ['-Xmx2048M', '-jar', 'server.jar', 'nogui'],
  };
  await Promise.all([runtime.start(spec), runtime.start(spec)]);
  assert.equal(creates, 1);
  runtime.shutdown();
});

test('adoption does not reuse online state from a previous container run', async () => {
  const panel = {
    Image: 'sha256:panel-image',
    Config: { Labels: { 'com.docker.compose.project': 'panel-project' } },
    Mounts: [{ Type: 'volume', Source: '/volumes/current', Destination: '/app/servers', RW: true }],
  };
  const child = {
    Id: 'child-9',
    Config: { Labels: {
      'io.mc-panel.managed': 'true',
      'io.mc-panel.instance': 'test-instance',
      'io.mc-panel.server-id': '9',
    } },
    HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
    Mounts: [{ Type: 'bind', Source: '/volumes/current/9', Destination: '/server', RW: true }],
    State: { Running: false, StartedAt: '' },
  };
  let historyQuery = '';
  const client = {
    init: async () => ({}),
    inspectContainer: async (id) => id === 'panel' ? panel : child,
    listContainers: async () => [{ Id: child.Id }],
    logsText: async (_id, query) => { historyQuery = query; return ''; },
    logs: async () => {
      const response = new EventEmitter();
      return { response, close() { response.emit('close'); } };
    },
    attach: async () => new PassThrough(),
  };
  const runtime = createDockerRuntime({ client, panelRef: 'panel', serversDir: '/app/servers', instanceId: 'test-instance' });
  const states = [];
  runtime.on('state', (_serverId, state) => states.push(state));
  await runtime.init();
  runtime.handles.get(9).lifecycleStatus = 'online';
  child.State = { Running: true, StartedAt: new Date().toISOString() };
  await runtime.reconcile();
  assert.equal(states.at(-1), 'starting');
  assert.match(historyQuery, /since=\d+/);
  child.State.Health = { Status: 'healthy' };
  await runtime.reconcile();
  assert.equal(states.at(-1), 'online');
  runtime.shutdown();
});

test('server operations share one ordered lock', async () => {
  const sequence = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = withServerOperation(999, async () => {
    sequence.push('first-start');
    await gate;
    sequence.push('first-end');
  });
  const second = withServerOperation(999, async () => {
    sequence.push('second');
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sequence, ['first-start']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(sequence, ['first-start', 'first-end', 'second']);
});
