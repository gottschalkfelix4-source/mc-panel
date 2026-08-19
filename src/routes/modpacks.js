// Modpack routes: search/browse Modrinth & CurseForge, install with progress jobs,
// list/remove installed mods. All routes require authentication.

const express = require('express');
const { requireAuth, requireOperator } = require('../middleware/authMiddleware');
const { db } = require('../services/database');
const modrinth = require('../services/modrinthService');
const curseforge = require('../services/curseforgeService');
const modpackService = require('../services/modpackService');
const updateService = require('../services/updateService');
const accessService = require('../services/accessService');
const { requireServerAccess } = accessService;

const PROVIDERS = { modrinth, curseforge };
const VALID_PROVIDERS = Object.keys(PROVIDERS);

// Lazy-require to keep this route tolerant while services evolve.
function getInstaller() {
  try {
    return require('../services/installerService');
  } catch {
    return null;
  }
}

function invalidProvider(res, provider) {
  return res.status(400).json({
    error: `Invalid provider '${provider}'. Must be one of: ${VALID_PROVIDERS.join(', ')}`,
  });
}

function handleProviderError(res, provider, err) {
  if (err && err.message === curseforge.NOT_CONFIGURED_MSG) {
    return res
      .status(503)
      .json({ error: 'CurseForge API key not configured', provider: 'curseforge' });
  }
  return res
    .status(502)
    .json({ error: `Upstream provider error: ${err.message}`, provider });
}

function jobToCamel(r) {
  return {
    id: r.id,
    serverId: r.server_id,
    provider: r.provider,
    modpackId: r.modpack_id,
    name: r.name,
    status: r.status,
    percent: r.percent,
    stage: r.stage,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function modToCamel(r) {
  return {
    id: r.id,
    serverId: r.server_id,
    provider: r.provider,
    providerProjectId: r.provider_project_id,
    name: r.name,
    version: r.version,
    fileName: r.file_name,
    iconUrl: r.icon_url,
    mcVersion: r.mc_version || null,
    loader: r.loader || null,
    installedAt: r.installed_at,
  };
}

function init(app, io) {
  updateService.init(io);
  const router = express.Router();

  // All modpack routes require auth
  router.use(requireAuth);

  // Provider availability
  router.get('/api/modpacks/providers', (req, res) => {
    res.json({
      modrinth: { configured: true },
      curseforge: { configured: curseforge.isConfigured() },
    });
  });

  // Search modpacks
  router.get('/api/modpacks/search', async (req, res) => {
    const provider = req.query.provider || 'modrinth';
    if (!VALID_PROVIDERS.includes(provider)) return invalidProvider(res, provider);
    const q = req.query.q || '';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    try {
      const results = await PROVIDERS[provider].searchModpacks(q, limit, offset);
      res.json({ provider, results });
    } catch (err) {
      handleProviderError(res, provider, err);
    }
  });

  // List versions/files of a modpack
  router.get('/api/modpacks/:provider/:id/versions', async (req, res) => {
    const { provider, id } = req.params;
    if (!VALID_PROVIDERS.includes(provider)) return invalidProvider(res, provider);
    try {
      const versions = await PROVIDERS[provider].getVersions(id);
      res.json({ versions });
    } catch (err) {
      handleProviderError(res, provider, err);
    }
  });

  // Install a modpack onto a server (async job). Any user with server access may
  // install packs, but only operators/admins may remove them or change the loader.
  router.post('/api/servers/:id/modpacks/install', requireServerAccess, async (req, res) => {
    const serverId = Number(req.params.id);
    if (!Number.isInteger(serverId)) {
      return res.status(400).json({ error: 'Invalid server id' });
    }
    const server = db.prepare('SELECT id, loader, version FROM servers WHERE id = ?').get(serverId);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }
    const { provider, modpackId, versionId, name, iconUrl } = req.body || {};
    if (!VALID_PROVIDERS.includes(provider)) return invalidProvider(res, provider);
    if (!modpackId) {
      return res.status(400).json({ error: 'modpackId is required' });
    }
    if (provider === 'curseforge' && !curseforge.isConfigured()) {
      return res
        .status(503)
        .json({ error: 'CurseForge API key not configured', provider: 'curseforge' });
    }

    // Prevent loader mismatch on already-installed servers.
    const installer = getInstaller();
    if (installer && installer.isInstalled(serverId)) {
      try {
        const versions = await PROVIDERS[provider].getVersions(String(modpackId));
        const version =
          (versionId && versions.find((v) => String(v.id) === String(versionId))) ||
          versions[0];
        if (
          version &&
          version.loader &&
          server.loader &&
          String(version.loader).toLowerCase() !== String(server.loader).toLowerCase()
        ) {
          return res.status(409).json({
            error: 'Modpack benötigt anderen Loader',
            code: 'LOADER_MISMATCH',
            requiredLoader: version.loader,
            requiredVersion: version.mcVersion || null,
            currentLoader: server.loader,
            currentVersion: server.version,
          });
        }
      } catch (err) {
        return handleProviderError(res, provider, err);
      }
    }

    const jobId = modpackService.createJob({
      serverId,
      provider,
      modpackId: String(modpackId),
      versionId,
      name,
      iconUrl,
    });

    // Kick off the install pipeline without blocking the response
    setImmediate(() => {
      modpackService
        .runJob(io, jobId, { serverId, provider, modpackId: String(modpackId), versionId, name, iconUrl })
        .catch((err) => console.error(`modpack job ${jobId} crashed:`, err));
    });

    res.status(202).json({ jobId });
  });

  // Update state for a server's installed packs
  router.get('/api/servers/:id/updates', requireServerAccess, (req, res) => {
    const serverId = Number(req.params.id);
    if (!Number.isInteger(serverId)) {
      return res.status(400).json({ error: 'Invalid server id' });
    }
    res.json({ updates: updateService.listUpdates(serverId), updating: updateService.isUpdating(serverId) });
  });

  // Manually re-check providers for newer pack versions
  router.post('/api/servers/:id/updates/check', requireServerAccess, requireOperator, async (req, res) => {
    const serverId = Number(req.params.id);
    if (!Number.isInteger(serverId)) {
      return res.status(400).json({ error: 'Invalid server id' });
    }
    const updates = await updateService.checkServer(io, serverId);
    res.json({ updates });
  });

  // Run an available update: creates a backup first, then applies the new pack.
  router.post('/api/servers/:id/update', requireServerAccess, requireOperator, (req, res) => {
    const serverId = Number(req.params.id);
    if (!Number.isInteger(serverId)) {
      return res.status(400).json({ error: 'Invalid server id' });
    }
    const server = db.prepare('SELECT id, status FROM servers WHERE id = ?').get(serverId);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (server.status !== 'offline') {
      return res.status(409).json({ error: 'Server muss für ein Update offline sein', code: 'SERVER_NOT_OFFLINE' });
    }
    if (updateService.isUpdating(serverId)) {
      return res.status(409).json({ error: 'Für diesen Server läuft bereits ein Update', code: 'UPDATE_RUNNING' });
    }

    const { provider, projectId } = req.body || {};
    const available = updateService.listUpdates(serverId).filter((u) => u.available);
    const target =
      (provider && projectId
        ? available.find((u) => u.provider === provider && String(u.projectId) === String(projectId))
        : available[0]) || null;
    if (!target) {
      return res.status(404).json({ error: 'Kein Update verfügbar', code: 'NO_UPDATE' });
    }
    if (target.provider === 'curseforge' && !curseforge.isConfigured()) {
      return res
        .status(503)
        .json({ error: 'CurseForge API key not configured', provider: 'curseforge' });
    }

    const jobId = updateService.startUpdate(io, {
      serverId,
      provider: target.provider,
      projectId: target.projectId,
      versionId: target.latestVersionId,
      name: target.name,
      iconUrl: target.iconUrl,
    });
    res.status(202).json({ jobId });
  });

  // Poll a job
  router.get('/api/modpacks/jobs/:jobId', (req, res) => {
    const job = modpackService.getJob(req.params.jobId);
    if (!job || !accessService.canAccess(req.user, job.server_id)) {
      return res.status(404).json({ error: 'Job not found' });
    }
    res.json(jobToCamel(job));
  });

  // List installed mods/modpacks for a server
  router.get('/api/servers/:id/mods', requireServerAccess, (req, res) => {
    const serverId = Number(req.params.id);
    if (!Number.isInteger(serverId)) {
      return res.status(400).json({ error: 'Invalid server id' });
    }
    const mods = modpackService.listMods(serverId).map(modToCamel);
    res.json({ mods });
  });

  // Remove an installed mod/modpack
  router.delete('/api/servers/:id/mods/:modId', requireServerAccess, requireOperator, (req, res) => {
    const serverId = Number(req.params.id);
    const modId = Number(req.params.modId);
    if (!Number.isInteger(serverId) || !Number.isInteger(modId)) {
      return res.status(400).json({ error: 'Invalid server or mod id' });
    }
    const removed = modpackService.removeMod(serverId, modId);
    if (!removed) return res.status(404).json({ error: 'Mod not found' });
    res.json({ ok: true });
  });

  app.use(router);
}

module.exports = { init };
