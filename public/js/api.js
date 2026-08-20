/* api.js — thin REST client implementing the FIXED backend contract.
   Handles the bearer token (localStorage 'mcp_token') and 401 -> login. */
(function (global) {
  'use strict';

  var TOKEN_KEY = 'mcp_token';

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t) {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  }

  // Core fetch wrapper. Throws Error with .status on HTTP errors.
  // On 401 the token is dropped and App.onUnauthorized() is fired.
  async function request(path, opts) {
    opts = opts || {};
    var headers = {};
    var hasRawBody = opts.rawBody !== undefined;
    if (hasRawBody) headers['Content-Type'] = opts.contentType || 'application/octet-stream';
    else if (opts.body !== undefined) headers['Content-Type'] = opts.contentType || 'application/json';
    var tok = getToken();
    if (tok) headers['Authorization'] = 'Bearer ' + tok;

    var res;
    try {
      res = await fetch(path, {
        method: opts.method || 'GET',
        headers: headers,
        body: hasRawBody ? opts.rawBody : (opts.body !== undefined ? JSON.stringify(opts.body) : undefined)
      });
    } catch (netErr) {
      var e = new Error('Netzwerkfehler — Server nicht erreichbar.');
      e.status = 0;
      throw e;
    }

    if (res.status === 401) {
      setToken(null);
      if (global.App && typeof global.App.onUnauthorized === 'function') global.App.onUnauthorized();
      var u = new Error('Nicht autorisiert');
      u.status = 401;
      throw u;
    }

    if (res.ok && opts.response === 'blob') return res.blob();

    var ct = res.headers.get('content-type') || '';
    var data = ct.indexOf('application/json') !== -1 ? await res.json() : await res.text();

    if (!res.ok) {
      var msg = (data && (data.error || data.message)) || ('HTTP ' + res.status);
      var err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function qs(params) {
    var parts = [];
    Object.keys(params).forEach(function (k) {
      if (params[k] !== undefined && params[k] !== null && params[k] !== '') {
        parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
      }
    });
    return parts.length ? '?' + parts.join('&') : '';
  }

  var API = {
    getToken: getToken,
    setToken: setToken,

    /* ---- Auth ---- */
    setupStatus: function () { return request('/api/setup/status'); },
    setupAdmin: function (payload) { return request('/api/setup/admin', { method: 'POST', body: payload }); },
    login: function (username, password) {
      return request('/api/auth/login', { method: 'POST', body: { username: username, password: password } });
    },
    me: function () { return request('/api/auth/me'); },
    changePassword: function (payload) { return request('/api/auth/password', { method: 'POST', body: payload }); },
    logout: function () { return request('/api/auth/logout', { method: 'POST' }); },

    /* ---- Servers ---- */
    listServers: function () { return request('/api/servers'); },
    hostMetrics: function () { return request('/api/admin/host-metrics'); },
    adminListServers: function () { return request('/api/admin/servers'); },
    listJobs: function () { return request('/api/admin/jobs'); },
    cancelJob: function (jobId) { return request('/api/admin/jobs/' + encodeURIComponent(jobId) + '/cancel', { method: 'POST' }); },
    listAuditEvents: function (params) { return request('/api/admin/audit-events' + qs(params || {})); },
    createServer: function (payload) { return request('/api/servers', { method: 'POST', body: payload }); },
    deleteServer: function (id) { return request('/api/servers/' + encodeURIComponent(id), { method: 'DELETE' }); },
    power: function (id, action) { // action: 'start' | 'stop' | 'restart'
      return request('/api/servers/' + encodeURIComponent(id) + '/' + action, { method: 'POST' });
    },
    logs: function (id, limit) {
      return request('/api/servers/' + encodeURIComponent(id) + '/logs' + qs({ limit: limit || 200 }));
    },
    metricsHistory: function (id, minutes) {
      return request('/api/servers/' + encodeURIComponent(id) + '/metrics/history' + qs({ minutes: minutes || 60 }));
    },
    metricsSummary: function () { return request('/api/metrics/summary'); },
    getServerResources: function (id) {
      return request('/api/servers/' + encodeURIComponent(id) + '/resources');
    },
    updateServerResources: function (id, payload) {
      return request('/api/servers/' + encodeURIComponent(id) + '/resources', { method: 'PUT', body: payload });
    },

    /* ---- Modpacks ---- */
    modpackProviders: function () { return request('/api/modpacks/providers'); },
    searchModpacks: function (provider, q, limit, offset) {
      return request('/api/modpacks/search' + qs({ provider: provider, q: q || '', limit: limit || 20, offset: offset || 0 }));
    },
    modpackVersions: function (provider, id) {
      return request('/api/modpacks/' + encodeURIComponent(provider) + '/' + encodeURIComponent(id) + '/versions');
    },
    installModpack: function (serverId, payload) {
      return request('/api/servers/' + encodeURIComponent(serverId) + '/modpacks/install', { method: 'POST', body: payload });
    },
    modpackJob: function (jobId) { return request('/api/modpacks/jobs/' + encodeURIComponent(jobId)); },

    /* ---- Modpack updates ---- */
    getUpdates: function (serverId) { return request('/api/servers/' + encodeURIComponent(serverId) + '/updates'); },
    checkUpdates: function (serverId) {
      return request('/api/servers/' + encodeURIComponent(serverId) + '/updates/check', { method: 'POST' });
    },
    runUpdate: function (serverId, payload) {
      return request('/api/servers/' + encodeURIComponent(serverId) + '/update', { method: 'POST', body: payload || {} });
    },

    /* ---- Mods ---- */
    listMods: function (serverId) { return request('/api/servers/' + encodeURIComponent(serverId) + '/mods'); },
    deleteMod: function (serverId, modId) {
      return request('/api/servers/' + encodeURIComponent(serverId) + '/mods/' + encodeURIComponent(modId), { method: 'DELETE' });
    },

    /* ---- Loaders / first-install / console (real mode) ---- */
    loaders: function () { return request('/api/loaders'); },
    loaderVersions: function (loader) {
      return request('/api/loaders/' + encodeURIComponent(loader) + '/versions');
    },
    installStatus: function (serverId) {
      return request('/api/servers/' + encodeURIComponent(serverId) + '/install-status');
    },
    installServer: function (serverId, payload) { // payload: {version, eulaAccepted: true}
      return request('/api/servers/' + encodeURIComponent(serverId) + '/install', { method: 'POST', body: payload });
    },
    sendCommand: function (serverId, command) {
      return request('/api/servers/' + encodeURIComponent(serverId) + '/command', { method: 'POST', body: { command: command } });
    },

    /* ---- Server management ---- */
    listServerFiles: function (serverId, path) {
      return request('/api/servers/' + encodeURIComponent(serverId) + '/files' + qs({ path: path || '' }));
    },
    getServerFile: function (serverId, path) {
      return request('/api/servers/' + encodeURIComponent(serverId) + '/files/content' + qs({ path: path }));
    },
    saveServerFile: function (serverId, path, content) {
      return request('/api/servers/' + encodeURIComponent(serverId) + '/files/content', {
        method: 'PUT', body: { path: path, content: content }
      });
    },
    createServerFolder: function (serverId, path) {
      return request('/api/servers/' + encodeURIComponent(serverId) + '/files/folder', { method: 'POST', body: { path: path } });
    },
    uploadServerFile: function (serverId, path, file) {
      return request('/api/servers/' + encodeURIComponent(serverId) + '/files/upload' + qs({ path: path }), {
        method: 'PUT', rawBody: file, contentType: 'application/octet-stream'
      });
    },
    downloadServerFile: function (serverId, path) {
      return request('/api/servers/' + encodeURIComponent(serverId) + '/files/download' + qs({ path: path }), { response: 'blob' });
    },
    renameServerFile: function (serverId, path, newPath) {
      return request('/api/servers/' + encodeURIComponent(serverId) + '/files/rename', {
        method: 'POST', body: { path: path, newPath: newPath }
      });
    },
    deleteServerFile: function (serverId, path) {
      return request('/api/servers/' + encodeURIComponent(serverId) + '/files', { method: 'DELETE', body: { path: path } });
    },
    listBackups: function (serverId) {
      return request('/api/servers/' + encodeURIComponent(serverId) + '/backups');
    },
    getGlobalBackupSettings: function () {
      return request('/api/backup-settings');
    },
    updateGlobalBackupSettings: function (payload) {
      return request('/api/backup-settings', { method: 'PUT', body: payload });
    },
    getServerBackupSettings: function (serverId) {
      return request('/api/servers/' + encodeURIComponent(serverId) + '/backup-settings');
    },
    updateServerBackupSettings: function (serverId, payload) {
      return request('/api/servers/' + encodeURIComponent(serverId) + '/backup-settings', { method: 'PUT', body: payload });
    },
    createBackup: function (serverId, name) {
      return request('/api/servers/' + encodeURIComponent(serverId) + '/backups', { method: 'POST', body: { name: name || undefined } });
    },
    backupJob: function (jobId) { return request('/api/backups/jobs/' + encodeURIComponent(jobId)); },
    downloadBackup: function (serverId, backupId) {
      return request('/api/servers/' + encodeURIComponent(serverId) + '/backups/' + encodeURIComponent(backupId) + '/download', { response: 'blob' });
    },
    restoreBackup: function (serverId, backupId) {
      return request('/api/servers/' + encodeURIComponent(serverId) + '/backups/' + encodeURIComponent(backupId) + '/restore', { method: 'POST' });
    },
    deleteBackup: function (serverId, backupId) {
      return request('/api/servers/' + encodeURIComponent(serverId) + '/backups/' + encodeURIComponent(backupId), { method: 'DELETE' });
    },
    listPlayers: function (serverId) {
      return request('/api/servers/' + encodeURIComponent(serverId) + '/players');
    },
    playerAction: function (serverId, payload) {
      return request('/api/servers/' + encodeURIComponent(serverId) + '/players/action', { method: 'POST', body: payload });
    },
    getServerProperties: function (serverId) {
      return request('/api/servers/' + encodeURIComponent(serverId) + '/properties');
    },
    updateServerProperties: function (serverId, changes) {
      return request('/api/servers/' + encodeURIComponent(serverId) + '/properties', { method: 'PUT', body: { changes: changes } });
    },

    /* ---- Users (admin) ---- */
    listUsers: function () { return request('/api/users'); },
    createUser: function (payload) { return request('/api/users', { method: 'POST', body: payload }); },
    updateUser: function (id, payload) {
      return request('/api/users/' + encodeURIComponent(id), { method: 'PATCH', body: payload });
    },
    resetUserPassword: function (id, payload) {
      return request('/api/users/' + encodeURIComponent(id) + '/password-reset', { method: 'POST', body: payload });
    },
    deleteUser: function (id) {
      return request('/api/users/' + encodeURIComponent(id), { method: 'DELETE' });
    },
    listUserServerOptions: function () { return request('/api/users/server-options'); },
    updateUserServers: function (id, serverIds) {
      return request('/api/users/' + encodeURIComponent(id) + '/servers', { method: 'PUT', body: { serverIds: serverIds } });
    },

    /* ---- Settings (admin) ---- */
    getSettings: function () { return request('/api/settings'); },
    saveCurseforgeKey: function (key) {
      return request('/api/settings/curseforge-key', { method: 'PUT', body: { key: key } });
    },
    deleteCurseforgeKey: function () {
      return request('/api/settings/curseforge-key', { method: 'DELETE' });
    },
    testCurseforgeKey: function (key) {
      return request('/api/settings/curseforge-key/test', { method: 'POST', body: key ? { key: key } : {} });
    }
  };

  global.API = API;
})(typeof window !== 'undefined' ? window : globalThis);
