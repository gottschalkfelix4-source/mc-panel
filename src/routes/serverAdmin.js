'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const { db, now } = require('../services/database');
const serverService = require('../services/serverService');
const processManager = require('../services/processManager');
const playerService = require('../services/playerService');
const propertiesService = require('../services/propertiesService');
const metricsService = require('../services/metricsService');
const accessService = require('../services/accessService');
const jobsService = require('../services/jobsService');
const auditService = require('../services/auditService');
const { validateUsername, validatePassword } = require('../services/passwordPolicy');
const { requireServerAccess } = accessService;
const {
  requireAuth,
  requireOperator,
  requireAdmin,
  normalizedRole,
} = require('../middleware/authMiddleware');

const ROLES = new Set(['admin', 'operator', 'viewer']);

function publicRole(role) {
  return normalizedRole(role);
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    role: publicRole(row.role),
    createdAt: row.created_at,
    active: Boolean(row.active),
    mustChangePassword: Boolean(row.must_change_password),
  };
}

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function requireServer(req, res, next) {
  const id = parseId(req.params.id);
  const server = id && serverService.getServer(id);
  if (!server) return res.status(404).json({ error: 'Server wurde nicht gefunden.' });
  req.serverId = id;
  req.serverRecord = server;
  next();
}

function sendError(res, error) {
  const status = Number.isInteger(error && error.status) ? error.status : 500;
  const message = status === 500 ? 'Interner Serverfehler.' : error.message;
  if (status === 500) console.error('[serverAdmin]', error);
  return res.status(status).json({ error: message });
}

function init(app, io) {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/api/servers/:id/players', requireServerAccess, requireServer, (req, res) => {
    const runtime = processManager.getRuntimeInfo(req.serverId);
    const onlineNames = runtime && Array.isArray(runtime.playerNames) ? runtime.playerNames : [];
    res.json({ players: playerService.list(req.serverId, onlineNames) });
  });

  router.post('/api/servers/:id/players/action', requireServerAccess, requireOperator, requireServer, async (req, res) => {
    try {
      const body = { ...(req.body || {}) };
      if (body.action === 'whitelist') body.action = 'whitelist-add';
      if (body.action === 'unwhitelist') body.action = 'whitelist-remove';
      const player = await playerService.action(req.serverId, body, processManager);
      res.json(player);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/api/servers/:id/properties', requireServerAccess, requireServer, (req, res) => {
    try {
      const result = propertiesService.get(req.serverId);
      result.values['server-port'] = req.serverRecord.port;
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.put('/api/servers/:id/properties', requireServerAccess, requireOperator, requireServer, async (req, res) => {
    try {
      const result = await propertiesService.update(req.serverId, (req.body || {}).changes);
      result.values['server-port'] = req.serverRecord.port;
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/api/users', requireAdmin, (req, res) => {
    const users = db.prepare('SELECT id, username, role, active, must_change_password, created_at FROM users ORDER BY id').all();
    res.json(users.map((user) => ({
      ...publicUser(user),
      serverIds: accessService.userServerIds(user.id),
    })));
  });

  router.get('/api/admin/host-metrics', requireAdmin, async (req, res) => {
    try {
      const metrics = await metricsService.getHostMetrics();
      res.json(metrics);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/api/admin/servers', requireAdmin, (req, res) => {
    try {
      const servers = serverService.listServers().map((srv) => ({
        ...srv,
        assignedUsers: accessService.serverUserNames(srv.id),
      }));
      res.json(servers);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/api/admin/jobs', requireAdmin, (req, res) => {
    try {
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || '100', 10)));
      res.json({ jobs: jobsService.listJobs(limit) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/api/admin/audit-events', requireAdmin, (req, res) => {
    try {
      const events = auditService.list({
        limit: req.query.limit,
        before: req.query.before,
        eventType: req.query.eventType,
        outcome: req.query.outcome,
        actor: req.query.actor,
        serverId: req.query.serverId,
      });
      res.json({ events, nextBefore: events.length ? events[events.length - 1].id : null });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/api/admin/jobs/:id/cancel', requireAdmin, (req, res) => {
    try {
      const result = jobsService.cancelJob(req.params.id);
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/api/users/server-options', requireAdmin, (req, res) => {
    const servers = serverService.listServers().map(({ id, name }) => ({ id, name }));
    res.json({ servers });
  });

  router.put('/api/users/:id/servers', requireAdmin, (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Ungültige Benutzer-ID.' });
    try {
      const serverIds = accessService.setUserServers(id, (req.body || {}).serverIds);
      io.in(`user:${id}`).disconnectSockets(true);
      res.json({ userId: id, serverIds });
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      if (status === 500) return sendError(res, error);
      return res.status(status).json({ error: error.message });
    }
  });

  router.post('/api/users', requireAdmin, (req, res) => {
    const { username, password, role } = req.body || {};
    const usernameError = validateUsername(username);
    const passwordError = validatePassword(password);
    if (usernameError) return res.status(400).json({ error: usernameError });
    if (passwordError) return res.status(400).json({ error: passwordError });
    if (!ROLES.has(role)) return res.status(400).json({ error: 'Rolle muss admin, operator oder viewer sein.' });
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
      return res.status(409).json({ error: 'Benutzername ist bereits vergeben.' });
    }
    bcrypt.hash(password, 12).then((passwordHash) => {
      const result = db.prepare(
        `INSERT INTO users
         (username, password_hash, role, created_at, active, token_version, must_change_password, password_changed_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 0, 1, ?, ?)`
      ).run(username, passwordHash, role, now(), now(), now());
      const user = db.prepare('SELECT id, username, role, active, must_change_password, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);
      res.status(201).json(publicUser(user));
    }).catch((error) => {
      if (String(error.message).includes('UNIQUE')) {
        return res.status(409).json({ error: 'Benutzername ist bereits vergeben.' });
      }
      sendError(res, error);
    });
  });

  router.patch('/api/users/:id', requireAdmin, (req, res) => {
    const id = parseId(req.params.id);
    const user = id && db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) return res.status(404).json({ error: 'Benutzer wurde nicht gefunden.' });

    const body = req.body || {};
    const keys = Object.keys(body);
    if (keys.length !== 1 || keys[0] !== 'role') {
      return res.status(400).json({ error: 'Über diesen Endpunkt kann nur die Rolle geändert werden.' });
    }
    const hasRole = Object.prototype.hasOwnProperty.call(body, 'role');
    if (hasRole && !ROLES.has(body.role)) {
      return res.status(400).json({ error: 'Rolle muss admin, operator oder viewer sein.' });
    }
    if (user.id === req.user.id) return res.status(409).json({ error: 'Die eigene Rolle kann nicht geändert werden.' });
    if (user.role === 'admin' && hasRole && body.role !== 'admin') {
      const { count } = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get();
      if (count <= 1) return res.status(409).json({ error: 'Der letzte Admin kann nicht herabgestuft werden.' });
    }

    const applyUpdate = async () => {
      const role = hasRole ? body.role : user.role;
      db.prepare(
        'UPDATE users SET role = ?, token_version = token_version + 1, updated_at = ? WHERE id = ?'
      ).run(role, now(), id);
      io.in(`user:${id}`).disconnectSockets(true);
      res.json(publicUser(db.prepare('SELECT id, username, role, active, must_change_password, created_at FROM users WHERE id = ?').get(id)));
    };
    applyUpdate().catch((error) => sendError(res, error));
  });

  router.post('/api/users/:id/password-reset', requireAdmin, async (req, res) => {
    const id = parseId(req.params.id);
    const target = id && db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target) return res.status(404).json({ error: 'Benutzer wurde nicht gefunden.' });
    if (id === req.user.id) {
      return res.status(409).json({ error: 'Das eigene Passwort wird über das persönliche Passwortformular geändert.' });
    }
    const { adminPassword, newPassword, passwordConfirm } = req.body || {};
    if (newPassword !== passwordConfirm) return res.status(400).json({ error: 'Passwörter stimmen nicht überein.' });
    const passwordError = validatePassword(newPassword);
    if (passwordError) return res.status(400).json({ error: passwordError });
    const actor = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!actor || !(await bcrypt.compare(String(adminPassword || ''), actor.password_hash))) {
      return res.status(403).json({ error: 'Admin-Passwort ist falsch.' });
    }
    const passwordHash = await bcrypt.hash(newPassword, 12);
    db.prepare(
      `UPDATE users SET password_hash = ?, token_version = token_version + 1,
       must_change_password = 1, active = 1, password_changed_at = ?, updated_at = ? WHERE id = ?`
    ).run(passwordHash, now(), now(), id);
    io.in(`user:${id}`).disconnectSockets(true);
    res.json({ ok: true });
  });

  router.delete('/api/users/:id', requireAdmin, (req, res) => {
    const id = parseId(req.params.id);
    const user = id && db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) return res.status(404).json({ error: 'Benutzer wurde nicht gefunden.' });
    if (user.username === req.user.username) {
      return res.status(409).json({ error: 'Das eigene Benutzerkonto kann nicht gelöscht werden.' });
    }
    if (user.role === 'admin') {
      const { count } = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get();
      if (count <= 1) return res.status(409).json({ error: 'Der letzte Admin kann nicht gelöscht werden.' });
    }
    io.in(`user:${id}`).disconnectSockets(true);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  app.use(router);
}

module.exports = { init };
