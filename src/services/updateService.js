// Modpack update engine: periodically checks Modrinth/CurseForge for newer
// versions of installed packs, persists the result in modpack_update_state and
// notifies clients via socket. Updates run as a job chain: backup first, then
// the regular modpack install pipeline (mods/configs are replaced, worlds stay).

const { db, now } = require('./database');
const modrinth = require('./modrinthService');
const curseforge = require('./curseforgeService');
const modpackService = require('./modpackService');
const backupService = require('./backupService');
const { withServerOperation } = require('./serverOperationLock');

const PROVIDERS = { modrinth, curseforge };
const CHECK_INTERVAL_MIN = Math.max(
  15,
  parseInt(process.env.UPDATE_CHECK_INTERVAL_MINUTES || '360', 10)
);
const BACKUP_TIMEOUT_MS = 45 * 60 * 1000;

let timer = null;
let checking = false;
const activeUpdates = new Set(); // serverIds with a running update chain

function serviceError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function installedPacks(serverId = null) {
  const sql =
    'SELECT * FROM mods WHERE provider IN (\'modrinth\',\'curseforge\')' +
    (serverId ? ' AND server_id = ?' : '');
  return serverId ? db.prepare(sql).all(serverId) : db.prepare(sql).all();
}

// Compare installed pack metadata with the newest compatible provider version.
// Returns null when the provider cannot be checked right now.
async function checkPack(mod) {
  const svc = PROVIDERS[mod.provider];
  if (!svc) return null;
  if (mod.provider === 'curseforge' && !curseforge.isConfigured()) return null;

  const versions = await svc.getVersions(String(mod.provider_project_id));
  if (!versions || !versions.length) return null;

  const compatible = versions.filter((v) => {
    const mcOk = !mod.mc_version || !v.mcVersion || v.mcVersion === mod.mc_version;
    const loaderOk =
      !mod.loader || !v.loader || String(v.loader).toLowerCase() === String(mod.loader).toLowerCase();
    return mcOk && loaderOk;
  });
  const latest = compatible[0];
  if (!latest) return null;

  const installedMatch = compatible.find(
    (v) =>
      (mod.version_id && String(v.id) === String(mod.version_id)) || v.name === mod.version
  );
  // If the installed version is beyond the fetched window (e.g. CF top 25) and
  // its name differs from the latest, it is older -> update available.
  const available = installedMatch
    ? String(latest.id) !== String(installedMatch.id)
    : latest.name !== mod.version;

  return {
    available: available ? 1 : 0,
    latestVersionId: String(latest.id),
    latestVersionName: latest.name,
  };
}

function saveState(io, mod, result) {
  const prev = db
    .prepare(
      'SELECT available, latest_version_id FROM modpack_update_state WHERE server_id = ? AND provider = ? AND provider_project_id = ?'
    )
    .get(mod.server_id, mod.provider, String(mod.provider_project_id));
  db.prepare(
    `INSERT INTO modpack_update_state (server_id, provider, provider_project_id, available, latest_version_id, latest_version_name, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(server_id, provider, provider_project_id)
     DO UPDATE SET available = excluded.available, latest_version_id = excluded.latest_version_id,
       latest_version_name = excluded.latest_version_name, checked_at = excluded.checked_at`
  ).run(
    mod.server_id,
    mod.provider,
    String(mod.provider_project_id),
    result.available,
    result.latestVersionId,
    result.latestVersionName,
    now()
  );
  const changed =
    !prev ||
    prev.available !== result.available ||
    prev.latest_version_id !== result.latestVersionId;
  if (io && changed && result.available) {
    io.to(`server:${mod.server_id}`).emit('update:available', {
      serverId: mod.server_id,
      provider: mod.provider,
      projectId: String(mod.provider_project_id),
      name: mod.name,
      installedVersion: mod.version,
      latestVersion: result.latestVersionName,
    });
  }
  return changed;
}

async function checkServer(io, serverId) {
  const mods = installedPacks(serverId);
  for (const mod of mods) {
    try {
      const result = await checkPack(mod);
      if (result) saveState(io, mod, result);
    } catch (err) {
      console.error(
        `[updates] check failed for ${mod.provider}/${mod.provider_project_id} (server ${mod.server_id}):`,
        err.message
      );
    }
  }
  return listUpdates(serverId);
}

async function checkAll(io) {
  if (checking) return;
  checking = true;
  try {
    const packs = installedPacks();
    for (const mod of packs) {
      try {
        const result = await checkPack(mod);
        if (result) saveState(io, mod, result);
      } catch (err) {
        console.error(
          `[updates] check failed for ${mod.provider}/${mod.provider_project_id} (server ${mod.server_id}):`,
          err.message
        );
      }
    }
  } finally {
    checking = false;
  }
}

function listUpdates(serverId) {
  return db
    .prepare(
      `SELECT m.name, m.icon_url, m.version AS installed_version, m.provider,
              m.provider_project_id, s.available, s.latest_version_id, s.latest_version_name, s.checked_at
       FROM modpack_update_state s
       JOIN mods m ON m.server_id = s.server_id AND m.provider = s.provider
         AND m.provider_project_id = s.provider_project_id
       WHERE s.server_id = ?`
    )
    .all(serverId)
    .map((r) => ({
      provider: r.provider,
      projectId: r.provider_project_id,
      name: r.name,
      iconUrl: r.icon_url,
      installedVersion: r.installed_version,
      available: Boolean(r.available),
      latestVersionId: r.latest_version_id,
      latestVersionName: r.latest_version_name,
      checkedAt: r.checked_at,
    }));
}

function isUpdating(serverId) {
  return activeUpdates.has(Number(serverId));
}

function failJob(io, jobId, serverId, message) {
  db.prepare(
    "UPDATE modpack_jobs SET status = 'error', stage = 'error', error = ?, updated_at = ? WHERE id = ?"
  ).run(message, now(), jobId);
  if (io) {
    io.to(`server:${serverId}`).emit('modpack:progress', {
      jobId,
      serverId,
      status: 'error',
      stage: 'error',
      error: message,
    });
  }
}

async function waitForBackup(jobId) {
  const deadline = Date.now() + BACKUP_TIMEOUT_MS;
  for (;;) {
    const job = backupService.getJob(jobId);
    if (job && (job.status === 'done' || job.status === 'error')) return job;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

// Starts the update chain synchronously (creates the job row so the caller gets
// a jobId for tracking), then runs backup + pack apply in the background.
function startUpdate(io, { serverId, provider, projectId, versionId, name, iconUrl }) {
  serverId = Number(serverId);
  if (activeUpdates.has(serverId)) {
    throw serviceError(409, 'Für diesen Server läuft bereits ein Update.');
  }
  const jobId = modpackService.createJob({
    serverId,
    provider,
    modpackId: String(projectId),
    versionId,
    name,
    iconUrl,
  });
  activeUpdates.add(serverId);
  setImmediate(() => {
    withServerOperation(serverId, () => runUpdate(io, jobId, { serverId, provider, projectId, versionId, name, iconUrl }))
      .catch((err) => console.error(`[updates] update job ${jobId} crashed:`, err))
      .finally(() => activeUpdates.delete(serverId));
  });
  return jobId;
}

async function runUpdate(io, jobId, { serverId, provider, projectId, versionId, name, iconUrl }) {
  const progress = (patch) => {
    if (io) io.to(`server:${serverId}`).emit('modpack:progress', { jobId, serverId, ...patch });
  };

  const server = db.prepare('SELECT status FROM servers WHERE id = ?').get(serverId);
  if (!server || server.status !== 'offline') {
    failJob(io, jobId, serverId, 'Server muss für das Update offline sein.');
    return;
  }

  // 1. Safety backup before touching any files.
  progress({ status: 'running', stage: 'Erstelle Backup vor dem Update …', percent: 0 });
  const backup = backupService.create(serverId, `Vor Update ${name || projectId}`);
  const backupJob = await waitForBackup(backup.jobId);
  if (!backupJob || backupJob.status !== 'done') {
    failJob(
      io,
      jobId,
      serverId,
      'Backup vor dem Update fehlgeschlagen: ' +
        ((backupJob && backupJob.error) || 'Zeitüberschreitung') +
        ' — Update wurde abgebrochen.'
    );
    return;
  }

  // 2. Regular modpack pipeline with the target version.
  progress({ status: 'running', stage: 'Backup fertig — installiere Update …', percent: 2 });
  await modpackService.runJob(io, jobId, {
    serverId,
    provider,
    modpackId: String(projectId),
    versionId,
    name,
    iconUrl,
  });

  // 3. Refresh the update state for this server.
  const job = modpackService.getJob(jobId);
  if (job && job.status === 'done') {
    db.prepare(
      'UPDATE modpack_update_state SET available = 0, checked_at = ? WHERE server_id = ? AND provider = ? AND provider_project_id = ?'
    ).run(now(), serverId, provider, String(projectId));
    checkServer(io, serverId).catch(() => {});
  }
}

function init(io) {
  if (timer) return;
  // First check shortly after boot, then on a fixed interval.
  setTimeout(() => checkAll(io).catch(() => {}), 30 * 1000);
  timer = setInterval(() => checkAll(io).catch(() => {}), CHECK_INTERVAL_MIN * 60 * 1000);
  timer.unref();
  console.log(`[updates] modpack update check every ${CHECK_INTERVAL_MIN} min`);
}

module.exports = { init, listUpdates, checkServer, checkAll, startUpdate, isUpdating };
