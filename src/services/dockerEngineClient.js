'use strict';

const http = require('http');

function apiVersionNumber(value) {
  const match = String(value || '').match(/^(\d+)\.(\d+)$/);
  return match ? Number(match[1]) * 1000 + Number(match[2]) : 0;
}

function dockerError(statusCode, body) {
  const message = body && body.message ? body.message : `Docker API HTTP ${statusCode}`;
  const error = new Error(message);
  error.statusCode = statusCode;
  error.docker = true;
  return error;
}

function createDockerClient(options = {}) {
  const socketPath = options.socketPath === undefined ? '/var/run/docker.sock' : options.socketPath;
  const host = options.host || '127.0.0.1';
  const port = options.port;
  const timeoutMs = options.timeoutMs || 15_000;
  const maxBytes = options.maxResponseBytes || 4 * 1024 * 1024;
  const maxApiVersion = options.maxApiVersion || '1.51';
  let prefix = '';

  function requestOptions(method, requestPath, headers = {}) {
    const base = { method, path: `${prefix}${requestPath}`, headers };
    return socketPath ? { ...base, socketPath } : { ...base, host, port };
  }

  function request(method, requestPath, options = {}) {
    const expected = options.expectedStatuses || [200];
    const payload = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    return new Promise((resolve, reject) => {
      const req = http.request(requestOptions(method, requestPath, headers), (res) => {
        const chunks = [];
        let size = 0;
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('Docker API response aborted')));
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new Error('Docker API response exceeded size limit'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body = null;
          if (text) {
            try { body = JSON.parse(text); } catch { body = text; }
          }
          if (!expected.includes(res.statusCode)) return reject(dockerError(res.statusCode, body));
          resolve(body);
        });
      });
      req.setTimeout(options.timeoutMs || timeoutMs, () => req.destroy(new Error('Docker API request timed out')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  function stream(requestPath, onData) {
    return new Promise((resolve, reject) => {
      const req = http.request(requestOptions('GET', requestPath), (res) => {
        if (res.statusCode !== 200) {
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
              req.destroy(new Error('Docker API response exceeded size limit'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            let body = null;
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
            reject(dockerError(res.statusCode, body));
          });
          return;
        }
        req.setTimeout(0);
        res.on('data', (chunk) => {
          try { onData(chunk); } catch (error) { req.destroy(error); }
        });
        // Stream failures are observed through close and reconciled by the runtime.
        res.on('error', () => {});
        res.on('aborted', () => req.destroy());
        resolve({ request: req, response: res, close: () => req.destroy() });
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error('Docker stream handshake timed out')));
      req.on('error', reject);
      req.end();
    });
  }

  function attach(containerId) {
    const id = encodeURIComponent(containerId);
    const requestPath = `/containers/${id}/attach?stream=1&stdin=1&stdout=0&stderr=0&logs=0`;
    return new Promise((resolve, reject) => {
      const req = http.request(requestOptions('POST', requestPath, {
        Connection: 'Upgrade',
        Upgrade: 'tcp',
      }));
      req.setTimeout(timeoutMs, () => req.destroy(new Error('Docker attach timed out')));
      req.on('upgrade', (res, socket, head) => {
        req.setTimeout(0);
        if (head && head.length) socket.unshift(head);
        resolve(socket);
      });
      req.on('response', (res) => {
        req.setTimeout(0);
        res.resume();
        reject(dockerError(res.statusCode, null));
      });
      req.on('error', reject);
      req.end();
    });
  }

  async function init() {
    await request('GET', '/_ping', { expectedStatuses: [200] });
    const version = await request('GET', '/version');
    const daemonVersion = version && version.ApiVersion;
    const selected = apiVersionNumber(daemonVersion) && apiVersionNumber(daemonVersion) < apiVersionNumber(maxApiVersion)
      ? daemonVersion
      : maxApiVersion;
    prefix = `/v${selected}`;
    return { apiVersion: selected, version };
  }

  return {
    init,
    request,
    stream,
    attach,
    inspectContainer: (id) => request('GET', `/containers/${encodeURIComponent(id)}/json`),
    listContainers: (filters) => request('GET', `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify(filters || {}))}`),
    createContainer: (name, body) => request('POST', `/containers/create?name=${encodeURIComponent(name)}`, { body, expectedStatuses: [201] }),
    startContainer: (id) => request('POST', `/containers/${encodeURIComponent(id)}/start`, { expectedStatuses: [204, 304] }),
    stopContainer: (id, seconds = 55) => request('POST', `/containers/${encodeURIComponent(id)}/stop?t=${seconds}`, { expectedStatuses: [204, 304] }),
    restartContainer: (id, seconds = 55) => request('POST', `/containers/${encodeURIComponent(id)}/restart?t=${seconds}`, { expectedStatuses: [204] }),
    waitContainer: (id, seconds = 45) => request('POST', `/containers/${encodeURIComponent(id)}/wait?condition=not-running`, { timeoutMs: (seconds + 2) * 1000 }),
    updateContainer: (id, body) => request('POST', `/containers/${encodeURIComponent(id)}/update`, { body }),
    removeContainer: (id, force = false) => request('DELETE', `/containers/${encodeURIComponent(id)}?force=${force ? 1 : 0}&v=0`, { expectedStatuses: [204] }),
    stats: (id) => request('GET', `/containers/${encodeURIComponent(id)}/stats?stream=false&one-shot=true`),
    logs: (id, query, onData) => stream(`/containers/${encodeURIComponent(id)}/logs?${query}`, onData),
    logsText: (id, query) => request('GET', `/containers/${encodeURIComponent(id)}/logs?${query}`),
  };
}

module.exports = { createDockerClient, apiVersionNumber };
