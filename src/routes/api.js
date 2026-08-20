// Core REST API routes. Export init(app, io).
'use strict';

const bcrypt = require('bcrypt');
const { rateLimit } = require('express-rate-limit');
const { db } = require('../services/database');
const serverService = require('../services/serverService');
const processManager = require('../services/processManager');
const metricsService = require('../services/metricsService');
const settingsService = require('../services/settingsService');
const curseforgeService = require('../services/curseforgeService');
const accessService = require('../services/accessService');
const setupService = require('../services/setupService');
const { validatePassword } = require('../services/passwordPolicy');
const { requireAuth, requireOperator, requireAdmin, signToken } = require('../middleware/authMiddleware');
const { requireServerAccess } = accessService;

function parseId(param) {
  const id = Number(param);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function normalizeLoader(value) {
  const compact = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  return compact === 'quilt' ? 'fabric' : compact;
}

// Lazy-require: installerService is built in parallel and may not exist yet.
function getInstaller() {
  try {
    return require('../services/installerService');
  } catch {
    return null;
  }
}

function init(app, io) {
  // --- Auth ---------------------------------------------------------------

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: 'Zu viele Login-Versuche. Bitte später erneut versuchen.' },
  });
  const setupLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Zu viele Setup-Versuche. Bitte später erneut versuchen.' },
  });
  const dummyHash = '$2b$12$D0zdcBqLVaWqt801Rn1GHevqzPzL0PUritcD3MALogKrUDphf8teG';

  app.get('/api/setup/status', (req, res) => {
    res.json({ setupRequired: setupService.setupRequired() });
  });

  app.post('/api/setup/admin', setupLimiter, async (req, res) => {
    const { username, password, passwordConfirm, setupToken } = req.body || {};
    req.auditUsername = typeof username === 'string' ? username : null;
    if (password !== passwordConfirm) return res.status(400).json({ error: 'Passwörter stimmen nicht überein.' });
    try {
      const user = await setupService.createInitialAdmin({ username, password, token: setupToken });
      res.status(201).json({ token: signToken(user), user: { id: user.id, username: user.username, role: user.role } });
    } catch (error) {
      res.status(Number.isInteger(error.status) ? error.status : 500)
        .json({ error: error.status ? error.message : 'Ersteinrichtung fehlgeschlagen.' });
    }
  });

  app.post('/api/auth/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body || {};
    req.auditUsername = typeof username === 'string' ? username : null;
    if (typeof username !== 'string' || typeof password !== 'string' || username.length > 64 || password.length > 128) {
      return res.status(400).json({ error: 'username and password are required' });
    }
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    const valid = await bcrypt.compare(password, user ? user.password_hash : dummyHash);
    if (!user || !user.active || !valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    res.json({
      token: signToken(user),
      user: { id: user.id, username: user.username, role: user.role, mustChangePassword: Boolean(user.must_change_password) },
    });
  });

  app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ user: { id: req.user.id, username: req.user.username, role: req.user.role, mustChangePassword: req.user.mustChangePassword } });
  });

  app.post('/api/auth/password', requireAuth, async (req, res) => {
    const { currentPassword, newPassword, passwordConfirm } = req.body || {};
    if (newPassword !== passwordConfirm) return res.status(400).json({ error: 'Passwörter stimmen nicht überein.' });
    const policyError = validatePassword(newPassword);
    if (policyError) return res.status(400).json({ error: policyError });
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!row || !(await bcrypt.compare(String(currentPassword || ''), row.password_hash))) {
      return res.status(403).json({ error: 'Aktuelles Passwort ist falsch.' });
    }
    const passwordHash = await bcrypt.hash(newPassword, 12);
    const timestamp = Date.now();
    db.prepare(
      `UPDATE users SET password_hash = ?, token_version = token_version + 1,
       must_change_password = 0, password_changed_at = ?, updated_at = ? WHERE id = ?`
    ).run(passwordHash, timestamp, timestamp, row.id);
    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(row.id);
    io.in(`user:${row.id}`).disconnectSockets(true);
    res.json({
      token: signToken(updated),
      user: { id: updated.id, username: updated.username, role: updated.role, mustChangePassword: false },
    });
  });

  app.post('/api/auth/logout', requireAuth, (req, res) => {
    db.prepare('UPDATE users SET token_version = token_version + 1, updated_at = ? WHERE id = ?')
      .run(Date.now(), req.user.id);
    io.in(`user:${req.user.id}`).disconnectSockets(true);
    res.json({ ok: true });
  });

  // --- Servers ------------------------------------------------------------

  app.get('/api/servers', requireAuth, (req, res) => {
    const servers = serverService.listServers(req.user);
    for (const s of servers) {
      s.metrics = serverService.latestMetric(s.id);
    }
    res.json(servers);
  });

  app.post('/api/servers', requireAuth, requireAdmin, (req, res) => {
    const { name, version = '1.21.1', loader = 'vanilla', icon = 'grass' } = req.body || {};
    const port = Number((req.body || {}).port ?? 25565);
    const ramMb = Number((req.body || {}).ramMb ?? 4096);
    const cpuCores = Number((req.body || {}).cpuCores ?? 2);

    if (typeof name !== 'string' || name.trim().length < 3 || name.trim().length > 32) {
      return res.status(400).json({ error: 'name must be 3-32 characters' });
    }
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return res.status(400).json({ error: 'port must be an integer between 1024 and 65535' });
    }
    if (!Number.isInteger(ramMb) || ramMb < 512 || ramMb > 65536) {
      return res.status(400).json({ error: 'ramMb must be an integer between 512 and 65536' });
    }
    if (!Number.isInteger(cpuCores) || cpuCores < 1 || cpuCores > serverService.maxCpuCores()) {
      return res.status(400).json({
        error: `cpuCores must be an integer between 1 and ${serverService.maxCpuCores()}`,
      });
    }
    if (serverService.portTaken(port)) {
      return res.status(409).json({ error: 'port is already in use by another server' });
    }

    const server = serverService.createServer({
      name: name.trim(),
      version: String(version),
      loader: String(loader),
      port,
      ramMb,
      cpuCores,
      icon: String(icon),
    });
    res.status(201).json(server);
  });

  app.get('/api/servers/:id', requireAuth, requireServerAccess, (req, res) => {
    const id = parseId(req.params.id);
    const server = id && serverService.getServer(id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    server.metrics = serverService.latestMetric(server.id);
    res.json(server);
  });

  app.get('/api/servers/:id/resources', requireAuth, requireServerAccess, (req, res) => {
    const server = serverService.getServer(req.serverAccessId);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    res.json({
      ramMb: server.ramMb,
      cpuCores: server.cpuCores,
      maxCpuCores: serverService.maxCpuCores(),
      restartRequired: false,
    });
  });

  app.put('/api/servers/:id/resources', requireAuth, requireServerAccess, requireAdmin, (req, res) => {
    const id = req.serverAccessId;
    const server = serverService.getServer(id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (server.status !== 'offline') {
      return res.status(409).json({ error: 'Server must be offline before changing resources' });
    }
    const body = req.body || {};
    const resources = {};
    if (Object.prototype.hasOwnProperty.call(body, 'ramMb')) resources.ramMb = body.ramMb;
    if (Object.prototype.hasOwnProperty.call(body, 'cpuCores')) resources.cpuCores = body.cpuCores;
    try {
      const updated = serverService.updateResources(id, resources);
      res.json({
        ramMb: updated.ramMb,
        cpuCores: updated.cpuCores,
        maxCpuCores: serverService.maxCpuCores(),
        restartRequired: false,
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.delete('/api/servers/:id', requireAuth, requireServerAccess, requireAdmin, (req, res) => {
    const id = parseId(req.params.id);
    const server = id && serverService.getServer(id);
    if (!server) return res.status(404).json({ error: 'Server not found' });

    processManager.cleanup(id); // stop simulated process immediately (no async DB writes after delete)
    serverService.deleteServer(id);
    res.json({ ok: true, deleted: id });
  });

  // --- Power actions --------------------------------------------------------

  function activeInstallJob(serverId) {
    return db.prepare(
      "SELECT id FROM modpack_jobs WHERE server_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1"
    ).get(serverId);
  }

  const powerAction = (action) => (req, res) => {
    const id = parseId(req.params.id);
    const server = id && serverService.getServer(id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (action === 'restart' && activeInstallJob(id)) {
      return res.status(409).json({
        error: 'Installation läuft noch — bitte bis 100 % warten',
        code: 'INSTALL_IN_PROGRESS',
      });
    }
    try {
      const status = processManager[action](id);
      res.json({ status });
    } catch (err) {
      res.status(409).json({ error: err.message });
    }
  };

  app.post('/api/servers/:id/start', requireAuth, requireServerAccess, (req, res) => {
    const id = parseId(req.params.id);
    const server = id && serverService.getServer(id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (activeInstallJob(id)) {
      return res.status(409).json({
        error: 'Installation läuft noch — bitte bis 100 % warten',
        code: 'INSTALL_IN_PROGRESS',
      });
    }
    const installer = getInstaller();
    if (processManager.getMode() === 'real' && !(installer && installer.isInstalled(id))) {
      return res.status(409).json({ error: 'Server ist nicht installiert', code: 'NOT_INSTALLED' });
    }
    try {
      const status = processManager.start(id);
      res.json({ status });
    } catch (err) {
      res.status(409).json({ error: err.message });
    }
  });
  app.post('/api/servers/:id/stop', requireAuth, requireServerAccess, powerAction('stop'));
  app.post('/api/servers/:id/restart', requireAuth, requireServerAccess, powerAction('restart'));

  // --- Installation & console ------------------------------------------------

  // Available loaders + current runtime mode.
  app.get('/api/loaders', requireAuth, (req, res) => {
    const installer = getInstaller();
    res.json({
      loaders: installer ? installer.getLoaders() : [],
      mode: processManager.getMode(),
    });
  });

  // Available Minecraft versions for a loader (upstream query, can fail).
  app.get('/api/loaders/:loader/versions', requireAuth, async (req, res) => {
    const installer = getInstaller();
    if (!installer) return res.status(503).json({ error: 'Installer nicht verfügbar' });
    const loader = normalizeLoader(req.params.loader);
    const known = installer.getLoaders().some((l) => (l && l.id ? l.id : l) === loader);
    if (!known) return res.status(400).json({ error: `Unbekannter Loader: ${loader}` });
    try {
      const versions = await installer.getVersions(loader);
      res.json({ versions });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get('/api/servers/:id/install-status', requireAuth, requireServerAccess, (req, res) => {
    const id = parseId(req.params.id);
    const server = id && serverService.getServer(id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    const installer = getInstaller();
    res.json({
      installed: installer ? !!installer.isInstalled(id) : !!server.installed,
      loader: server.loader,
      version: server.version,
    });
  });

  app.post('/api/servers/:id/install', requireAuth, requireServerAccess, requireOperator, async (req, res) => {
    const id = parseId(req.params.id);
    const server = id && serverService.getServer(id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    const { version, eulaAccepted, wipe, modpack } = req.body || {};
    if (eulaAccepted !== true) {
      return res.status(400).json({ error: 'EULA muss akzeptiert werden' });
    }
    if (processManager.getMode() !== 'real') {
      return res.status(400).json({ error: 'Im Simulationsmodus nicht verfügbar' });
    }
    const installer = getInstaller();
    if (!installer) return res.status(503).json({ error: 'Installer nicht verfügbar' });

    let loader = normalizeLoader(server.loader);
    let mcVersion = version ? String(version) : null;
    let modpackArg = null;

    if (modpack && modpack.provider && modpack.modpackId) {
      // The pack dictates loader + mcVersion: resolve the target version.
      const providers = {
        modrinth: require('../services/modrinthService'),
        curseforge: require('../services/curseforgeService'),
      };
      const svc = providers[modpack.provider];
      if (!svc) return res.status(400).json({ error: 'Invalid provider' });
      let packVersion = null;
      try {
        const versions = await svc.getVersions(String(modpack.modpackId));
        packVersion =
          (modpack.versionId &&
            (versions || []).find((v) => String(v.id) === String(modpack.versionId))) ||
          (versions || [])[0];
      } catch (err) {
        if (err && err.message === curseforgeService.NOT_CONFIGURED_MSG) {
          return res
            .status(503)
            .json({ error: 'CurseForge API key not configured', provider: 'curseforge' });
        }
        return res.status(502).json({ error: `Upstream provider error: ${err.message}` });
      }
      loader = normalizeLoader((packVersion && packVersion.loader) || 'forge');
      mcVersion = packVersion && packVersion.mcVersion;
      if (!mcVersion) {
        return res.status(400).json({ error: 'Modpack-Version konnte nicht aufgelöst werden' });
      }
      // Reflect the pack's loader/version on the server row before the job starts.
      db.prepare('UPDATE servers SET loader = ?, version = ? WHERE id = ?').run(
        loader,
        mcVersion,
        id
      );
      modpackArg = {
        provider: modpack.provider,
        modpackId: String(modpack.modpackId),
        versionId: modpack.versionId,
        name: modpack.name,
        iconUrl: modpack.iconUrl,
      };
    } else if (!mcVersion) {
      return res.status(400).json({ error: 'version is required' });
    }

    const jobId = installer.createInstallJob(io, {
      serverId: id,
      loader,
      mcVersion,
      port: server.port,
      wipe: wipe === true,
      modpack: modpackArg,
    });
    res.status(202).json({ jobId });
  });

  app.post('/api/servers/:id/command', requireAuth, requireServerAccess, (req, res) => {
    const id = parseId(req.params.id);
    const server = id && serverService.getServer(id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    const command = String((req.body || {}).command || '').trim();
    if (!command) return res.status(400).json({ error: 'command must not be empty' });
    if (server.status !== 'online') {
      return res.status(409).json({ error: 'Server ist nicht online' });
    }
    if (!processManager.sendCommand(id, command)) {
      return res.status(500).json({ error: 'Befehl konnte nicht an den Server gesendet werden' });
    }
    res.json({ ok: true });
  });

  // --- Logs & metrics -------------------------------------------------------

  app.get('/api/servers/:id/logs', requireAuth, requireServerAccess, (req, res) => {
    const id = parseId(req.params.id);
    if (!id || !serverService.getServer(id)) return res.status(404).json({ error: 'Server not found' });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
    const rows = db
      .prepare('SELECT ts, line FROM logs WHERE server_id = ? ORDER BY ts DESC, id DESC LIMIT ?')
      .all(id, limit);
    res.json({ lines: rows.reverse() }); // chronological order
  });

  app.get('/api/servers/:id/metrics/history', requireAuth, requireServerAccess, (req, res) => {
    const id = parseId(req.params.id);
    if (!id || !serverService.getServer(id)) return res.status(404).json({ error: 'Server not found' });
    const minutes = Math.min(Math.max(parseInt(req.query.minutes, 10) || 60, 1), 60 * 72);
    res.json({ points: metricsService.getHistory(id, minutes) });
  });

  app.get('/api/metrics/summary', requireAuth, (req, res) => {
    res.json(metricsService.getSummary(accessService.accessibleServerIds(req.user)));
  });

  // --- Settings (admin only) -------------------------------------------------

  function maskKey(key) {
    if (!key) return null;
    if (key.length <= 8) return '••••••••';
    return '••••••••' + key.slice(-4);
  }

  // Current settings state (never returns the full key, only a masked hint).
  app.get('/api/settings', requireAuth, requireAdmin, (req, res) => {
    const dbKey = settingsService.get(settingsService.KEYS.CURSEFORGE_API_KEY);
    const envKey = process.env.CURSEFORGE_API_KEY || null;
    const effective = dbKey || envKey;
    res.json({
      curseforgeKey: {
        configured: Boolean(effective),
        source: dbKey ? 'database' : envKey ? 'env' : null,
        masked: maskKey(effective),
      },
    });
  });

  // Save CurseForge API key to the DB (takes precedence over env).
  app.put('/api/settings/curseforge-key', requireAuth, requireAdmin, (req, res) => {
    const key = String((req.body || {}).key || '').trim();
    if (key.length < 10 || key.length > 200) {
      return res.status(400).json({ error: 'key must be 10-200 characters' });
    }
    settingsService.set(settingsService.KEYS.CURSEFORGE_API_KEY, key);
    res.json({ ok: true, masked: maskKey(key) });
  });

  // Remove the DB-stored key (env var, if set, becomes active again).
  app.delete('/api/settings/curseforge-key', requireAuth, requireAdmin, (req, res) => {
    settingsService.remove(settingsService.KEYS.CURSEFORGE_API_KEY);
    res.json({ ok: true, configured: curseforgeService.isConfigured() });
  });

  // Test a key against the CurseForge API (body key wins, else saved/env key).
  app.post('/api/settings/curseforge-key/test', requireAuth, requireAdmin, async (req, res) => {
    const candidate = String((req.body || {}).key || '').trim() ||
      settingsService.get(settingsService.KEYS.CURSEFORGE_API_KEY) ||
      process.env.CURSEFORGE_API_KEY || '';
    if (!candidate) {
      return res.status(400).json({ error: 'Kein Key zum Testen vorhanden' });
    }
    try {
      const r = await fetch(
        'https://api.curseforge.com/v1/mods/search?gameId=432&classId=4471&pageSize=1',
        { headers: { 'x-api-key': candidate, Accept: 'application/json' } }
      );
      if (r.ok) return res.json({ ok: true, message: 'Verbindung zu CurseForge erfolgreich!' });
      if (r.status === 403) return res.status(403).json({ error: 'Key ungültig (CurseForge: 403 Forbidden)' });
      res.status(502).json({ error: `CurseForge antwortet mit HTTP ${r.status}` });
    } catch (err) {
      res.status(502).json({ error: `CurseForge nicht erreichbar: ${err.message}` });
    }
  });
}

module.exports = { init };
