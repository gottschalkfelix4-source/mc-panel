'use strict';

const express = require('express');
const path = require('path');
const { requireAuth, requireOperator, requireAdmin } = require('../middleware/authMiddleware');
const accessService = require('../services/accessService');
const { requireServerAccess } = accessService;
const serverService = require('../services/serverService');
const fileService = require('../services/fileService');
const backupService = require('../services/backupService');
const backupPolicy = require('../services/backupPolicyService');

function loadServer(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(404).json({ error: 'Server not found' });
    return null;
  }
  const server = serverService.getServer(id);
  if (!server) {
    res.status(404).json({ error: 'Server not found' });
    return null;
  }
  return server;
}

function validBackupId(value) {
  return typeof value === 'string' &&
    value.length > 4 &&
    !value.includes('\0') &&
    path.basename(value) === value &&
    path.posix.basename(value) === value &&
    value.endsWith('.zip');
}

function sendError(res, err) {
  if (res.headersSent) return;
  if (err && err.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
  if (err && (err.code === 'TOO_LARGE' || err.type === 'entity.too.large')) {
    return res.status(413).json({ error: 'Payload too large' });
  }
  if (err && err.code === 'NOT_EDITABLE') return res.status(415).json({ error: err.message });
  if (err && err.code === 'FORBIDDEN') return res.status(403).json({ error: err.message });
  if (err && ['VALIDATION', 'EINVAL', 'EISDIR', 'ENOTDIR', 'EEXIST', 'ENOTEMPTY'].includes(err.code)) {
    return res.status(400).json({ error: err.message || 'Invalid request' });
  }
  console.error('[files/backups]', err);
  return res.status(500).json({ error: 'Internal server error' });
}

function handle(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      sendError(res, err);
    }
  };
}

async function serverBackupState(serverId) {
  const settings = backupPolicy.serverSettings(serverId);
  const [usage, global] = await Promise.all([
    backupPolicy.usage(serverId),
    Promise.resolve(backupPolicy.globalSettings()),
  ]);
  return {
    settings,
    usage,
    limits: {
      serverMaxBytes: settings.maxBytes,
      globalMaxBytes: global.globalMaxBytes,
    },
  };
}

function init(app, io) {
  backupService.init(io);
  const uploadBody = express.raw({ type: 'application/octet-stream', limit: '512mb' });
  const parseUpload = (req, res, next) => uploadBody(req, res, (err) => {
    if (err) return sendError(res, err);
    next();
  });

  app.get('/api/servers/:id/files', requireAuth, requireServerAccess, handle(async (req, res) => {
    const server = loadServer(req, res);
    if (!server) return;
    res.json(await fileService.list(server.id, req.query.path || ''));
  }));

  app.get('/api/servers/:id/files/content', requireAuth, requireServerAccess, handle(async (req, res) => {
    const server = loadServer(req, res);
    if (!server) return;
    res.json(await fileService.readText(server.id, req.query.path));
  }));

  app.put('/api/servers/:id/files/content', requireAuth, requireServerAccess, requireOperator, handle(async (req, res) => {
    const server = loadServer(req, res);
    if (!server) return;
    const { path: filePath, content } = req.body || {};
    await fileService.writeText(server.id, filePath, content);
    res.json({ ok: true });
  }));

  app.post('/api/servers/:id/files/folder', requireAuth, requireServerAccess, requireOperator, handle(async (req, res) => {
    const server = loadServer(req, res);
    if (!server) return;
    await fileService.createFolder(server.id, (req.body || {}).path);
    res.status(201).json({ ok: true });
  }));

  app.put(
    '/api/servers/:id/files/upload',
    requireAuth,
    requireServerAccess,
    requireOperator,
    parseUpload,
    handle(async (req, res) => {
      const server = loadServer(req, res);
      if (!server) return;
      if (typeof req.query.path !== 'string' || !req.query.path.trim()) {
        return res.status(400).json({ error: 'path is required' });
      }
      await fileService.writeBinary(server.id, req.query.path, req.body);
      res.json({ ok: true });
    })
  );

  app.get('/api/servers/:id/files/download', requireAuth, requireServerAccess, handle(async (req, res) => {
    const server = loadServer(req, res);
    if (!server) return;
    const downloadPath = await fileService.getDownloadPath(server.id, req.query.path);
    res.download(downloadPath, path.basename(downloadPath), (err) => {
      if (err) sendError(res, err);
    });
  }));

  app.post('/api/servers/:id/files/rename', requireAuth, requireServerAccess, requireOperator, handle(async (req, res) => {
    const server = loadServer(req, res);
    if (!server) return;
    const body = req.body || {};
    await fileService.rename(server.id, body.path, body.newPath);
    res.json({ ok: true });
  }));

  app.delete('/api/servers/:id/files', requireAuth, requireServerAccess, requireOperator, handle(async (req, res) => {
    const server = loadServer(req, res);
    if (!server) return;
    await fileService.remove(server.id, (req.body || {}).path);
    res.json({ ok: true });
  }));

  app.get('/api/backup-settings', requireAuth, requireAdmin, handle(async (req, res) => {
    const [settings, usage] = await Promise.all([
      Promise.resolve(backupPolicy.globalSettings()),
      backupPolicy.usage(),
    ]);
    res.json({ ...settings, ...usage });
  }));

  app.put('/api/backup-settings', requireAuth, requireAdmin, handle(async (req, res) => {
    const settings = backupPolicy.updateGlobal(req.body || {});
    const usage = await backupPolicy.usage();
    res.json({ ...settings, ...usage });
  }));

  app.get('/api/servers/:id/backup-settings', requireAuth, requireServerAccess, handle(async (req, res) => {
    const server = loadServer(req, res);
    if (!server) return;
    const state = await serverBackupState(server.id);
    res.json({
      ...state.settings,
      ...state.usage,
      serverMaxBytes: state.limits.serverMaxBytes,
      globalMaxBytes: state.limits.globalMaxBytes,
    });
  }));

  app.put('/api/servers/:id/backup-settings', requireAuth, requireServerAccess, requireOperator, handle(async (req, res) => {
    const server = loadServer(req, res);
    if (!server) return;
    const settings = backupPolicy.updateServer(
      server.id,
      req.body || {},
      req.user && req.user.role === 'admin'
    );
    const state = await serverBackupState(server.id);
    res.json({
      ...settings,
      ...state.usage,
      serverMaxBytes: state.limits.serverMaxBytes,
      globalMaxBytes: state.limits.globalMaxBytes,
    });
  }));

  app.get('/api/servers/:id/backups', requireAuth, requireServerAccess, handle(async (req, res) => {
    const server = loadServer(req, res);
    if (!server) return;
    const [backups, state] = await Promise.all([
      backupService.list(server.id),
      serverBackupState(server.id),
    ]);
    res.json({ backups, usage: state.usage, settings: state.settings });
  }));

  app.post('/api/servers/:id/backups', requireAuth, requireServerAccess, requireOperator, handle(async (req, res) => {
    const server = loadServer(req, res);
    if (!server) return;
    const name = (req.body || {}).name;
    if (name != null && typeof name !== 'string') {
      return res.status(400).json({ error: 'name must be a string' });
    }
    const job = backupService.create(server.id, name);
    res.status(202).json({ jobId: job.id });
  }));

  app.get('/api/backups/jobs/:jobId', requireAuth, (req, res) => {
    const job = backupService.getJob(req.params.jobId);
    if (!job || !accessService.canAccess(req.user, job.serverId)) {
      return res.status(404).json({ error: 'Job not found' });
    }
    res.json(job);
  });

  app.get('/api/servers/:id/backups/:backupId/download', requireAuth, requireServerAccess, handle(async (req, res) => {
    const server = loadServer(req, res);
    if (!server) return;
    if (!validBackupId(req.params.backupId)) return res.status(400).json({ error: 'Invalid backup id' });
    const downloadPath = await backupService.getPath(server.id, req.params.backupId);
    res.download(downloadPath, req.params.backupId, (err) => {
      if (err) sendError(res, err);
    });
  }));

  app.post('/api/servers/:id/backups/:backupId/restore', requireAuth, requireServerAccess, requireOperator, handle(async (req, res) => {
    const server = loadServer(req, res);
    if (!server) return;
    if (!validBackupId(req.params.backupId)) return res.status(400).json({ error: 'Invalid backup id' });
    if (server.status !== 'offline') {
      return res.status(409).json({ error: 'Server must be offline before restore' });
    }
    await backupService.getPath(server.id, req.params.backupId);
    const job = backupService.restore(server.id, req.params.backupId);
    res.status(202).json({ jobId: job.id });
  }));

  app.delete('/api/servers/:id/backups/:backupId', requireAuth, requireServerAccess, requireOperator, handle(async (req, res) => {
    const server = loadServer(req, res);
    if (!server) return;
    if (!validBackupId(req.params.backupId)) return res.status(400).json({ error: 'Invalid backup id' });
    await backupService.remove(server.id, req.params.backupId);
    res.json({ ok: true });
  }));
}

module.exports = { init };
