// Modpack install pipeline with progress jobs.
// Jobs are persisted in the modpack_jobs table and streamed to clients
// via the socket.io event 'modpack:progress'.
// applyPack() REALLY applies a downloaded pack file to a server directory:
// downloads all mod files and extracts the overrides.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const unzipper = require('unzipper');
const { pipeline } = require('stream/promises');
const { db, now } = require('./database');
const modrinth = require('./modrinthService');
const curseforge = require('./curseforgeService');

const PROVIDERS = { modrinth, curseforge };
const DOWNLOAD_UA = 'MinecraftHostingPanel/1.0 (panel demo)';
const MAX_PARALLEL_DOWNLOADS = 4;

// Defensive: tables are created by database.js, but make sure we never crash
// if this service is exercised before the main schema init runs.
let tablesReady = false;
function ensureTables() {
  if (tablesReady) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS mods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER,
      provider TEXT,
      provider_project_id TEXT,
      name TEXT,
      version TEXT,
      file_name TEXT,
      icon_url TEXT,
      mc_version TEXT,
      loader TEXT,
      installed_at INTEGER,
      UNIQUE(server_id, provider, provider_project_id)
    );
    CREATE TABLE IF NOT EXISTS modpack_jobs (
      id TEXT PRIMARY KEY,
      server_id INTEGER,
      provider TEXT,
      modpack_id TEXT,
      name TEXT,
      status TEXT DEFAULT 'queued',
      percent REAL DEFAULT 0,
      stage TEXT,
      error TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );
  `);
  tablesReady = true;
}

// ---------------------------------------------------------------------------
// Job helpers
// ---------------------------------------------------------------------------

function createJob({ serverId, provider, modpackId, versionId, name, iconUrl }) {
  ensureTables();
  const jobId = crypto.randomUUID();
  const ts = now();
  db.prepare(
    `INSERT INTO modpack_jobs (id, server_id, provider, modpack_id, name, status, percent, stage, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'queued', 0, 'queued', NULL, ?, ?)`
  ).run(jobId, serverId, provider, String(modpackId), name || null, ts, ts);
  return jobId;
}

function getJob(jobId) {
  ensureTables();
  return db.prepare('SELECT * FROM modpack_jobs WHERE id = ?').get(jobId);
}

function listJobs(limit = 100) {
  ensureTables();
  return db
    .prepare('SELECT * FROM modpack_jobs ORDER BY created_at DESC LIMIT ?')
    .all(limit)
    .map((row) => ({
      id: row.id,
      type: 'modpack',
      serverId: row.server_id,
      name: row.name || 'Modpack installieren',
      provider: row.provider,
      status: row.status,
      percent: row.percent,
      stage: row.stage,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
}

function abortJob(jobId) {
  const row = getJob(jobId);
  if (!row) return false;
  if (row.status !== 'running' && row.status !== 'queued') return false;
  updateJob(jobId, { status: 'aborted', stage: 'aborted', error: 'Vom Administrator abgebrochen' });
  return true;
}

function updateJob(jobId, patch) {
  const allowed = ['status', 'percent', 'stage', 'error'];
  const sets = [];
  const vals = [];
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      sets.push(`${key} = ?`);
      vals.push(patch[key]);
    }
  }
  if (!sets.length) return;
  sets.push('updated_at = ?');
  vals.push(now());
  vals.push(jobId);
  db.prepare(`UPDATE modpack_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

// ---------------------------------------------------------------------------
// Mods helpers
// ---------------------------------------------------------------------------

function listMods(serverId) {
  ensureTables();
  return db
    .prepare('SELECT * FROM mods WHERE server_id = ? ORDER BY installed_at DESC')
    .all(serverId);
}

function removeMod(serverId, modId) {
  ensureTables();
  const row = db
    .prepare('SELECT * FROM mods WHERE id = ? AND server_id = ?')
    .get(modId, serverId);
  if (!row) return null;
  db.prepare('DELETE FROM mods WHERE id = ? AND server_id = ?').run(modId, serverId);
  // Best-effort cleanup of the downloaded modpack archive.
  if (row.file_name) {
    try {
      const filePath = path.join(modpackDir(serverId), path.basename(row.file_name));
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) {
      /* ignore file removal errors */
    }
  }
  return row;
}

function serverDir(serverId) {
  const base = path.resolve(process.cwd(), process.env.SERVERS_DIR || './servers');
  return path.join(base, String(serverId));
}

function modpackDir(serverId) {
  return path.join(serverDir(serverId), 'modpacks');
}

// ---------------------------------------------------------------------------
// Download with progress
// ---------------------------------------------------------------------------

async function downloadWithProgress(url, dest, onProgress, startPct = 5, endPct = 60) {
  const span = endPct - startPct;
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': DOWNLOAD_UA } });
  } catch (err) {
    throw new Error(`Download failed: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
  }

  const total = Number(res.headers.get('content-length')) || 0;
  const chunks = [];
  let received = 0;

  // If the server does not tell us the size, fake a smooth crawl towards the end.
  let fakeTimer = null;
  if (!total) {
    let fake = 0.08;
    fakeTimer = setInterval(() => {
      fake = Math.min(0.92, fake + Math.max(0.005, (0.92 - fake) * 0.08));
      onProgress(Math.round((startPct + fake * span) * 10) / 10);
    }, 200);
    if (typeof fakeTimer.unref === 'function') fakeTimer.unref();
  }

  try {
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        received += value.length;
        if (total) {
          const pct = startPct + (received / total) * span;
          onProgress(Math.min(endPct - 0.1, Math.round(pct * 10) / 10));
        }
      }
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      chunks.push(buf);
      received = buf.length;
    }
  } catch (err) {
    throw new Error(`Download interrupted: ${err.message}`);
  } finally {
    if (fakeTimer) clearInterval(fakeTimer);
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.concat(chunks, received));
  onProgress(endPct);
}

// Simple download without progress reporting (used for individual mod files).
async function downloadToFile(url, dest) {
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': DOWNLOAD_UA } });
  } catch (err) {
    throw new Error(`Download fehlgeschlagen: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`Download fehlgeschlagen: HTTP ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
}

// ---------------------------------------------------------------------------
// Pack application helpers
// ---------------------------------------------------------------------------

// Path traversal guard: the resolved target must stay inside base.
function safeJoin(base, rel) {
  const root = path.resolve(base);
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Unsicherer Pfad im Modpack: ${rel}`);
  }
  return target;
}

// Extract every entry under `<prefix>/` of the zip into dir (structure kept).
function extractOverrides(zip, prefix, dir) {
  const normalized = String(prefix || 'overrides').replace(/\\/g, '/').replace(/\/+$/, '') + '/';
  let count = 0;
  for (const entry of zip.getEntries()) {
    const name = entry.entryName.replace(/\\/g, '/');
    if (!name.startsWith(normalized)) continue;
    if (entry.isDirectory) continue;
    const rel = name.slice(normalized.length);
    if (!rel) continue;
    const target = safeJoin(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.getData());
    count++;
  }
  return count;
}

async function extractPreparedServerPack(packFilePath, dir, onProgress, metadata) {
  const archive = await unzipper.Open.file(packFilePath);
  const files = archive.files.filter((entry) => entry.type !== 'Directory');
  const roots = files.map((entry) => entry.path.replace(/\\/g, '/').split('/'));
  const commonRoot = roots.length && roots.every((parts) => parts.length > 1 && parts[0] === roots[0][0])
    ? roots[0][0] + '/'
    : '';

  let installed = 0;
  for (const entry of files) {
    const name = entry.path.replace(/\\/g, '/');
    const rel = commonRoot && name.startsWith(commonRoot) ? name.slice(commonRoot.length) : name;
    if (!rel) continue;
    const target = safeJoin(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await pipeline(entry.stream(), fs.createWriteStream(target));
    installed += 1;
    onProgress(installed, files.length, path.basename(rel));
  }

  return {
    filesInstalled: installed,
    skipped: 0,
    mcVersion: metadata.mcVersion || null,
    loader: metadata.loader || null,
  };
}

function clearPackFiles(dir) {
  for (const name of ['mods', 'config', 'defaultconfigs', 'kubejs', 'scripts']) {
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

// Minimal worker pool: at most `concurrency` workers run at the same time.
async function runPool(items, worker, concurrency = MAX_PARALLEL_DOWNLOADS) {
  let idx = 0;
  const lanes = Array.from(
    { length: Math.min(concurrency, Math.max(items.length, 1)) },
    async () => {
      while (idx < items.length) {
        const item = items[idx];
        idx += 1;
        await worker(item);
      }
    }
  );
  await Promise.all(lanes);
}

// Map the modrinth.index.json dependencies to (mcVersion, loader).
function mrpackLoader(deps) {
  const keys = Object.keys(deps || {}).filter((k) => k !== 'minecraft');
  if (!keys.length) return null;
  const key = keys[0];
  switch (key) {
    case 'fabric-loader':
      return 'fabric';
    case 'quilt-loader':
      return 'fabric'; // quilt packs run fine on fabric-ish setups in this panel
    case 'forge':
      return 'forge';
    case 'neoforge':
      return 'neoforge';
    default:
      return key.endsWith('-loader') ? key.slice(0, -'-loader'.length) : key;
  }
}

// CurseForge API key resolution (DB settings take precedence over env),
// replicated from curseforgeService since that module must not be modified.
function curseforgeApiKey() {
  try {
    const settings = require('./settingsService');
    const fromDb = settings.get(settings.KEYS.CURSEFORGE_API_KEY);
    if (fromDb) return fromDb;
  } catch {
    // settings table not ready yet — fall through to env
  }
  return process.env.CURSEFORGE_API_KEY || null;
}

// ---------------------------------------------------------------------------
// Real pack application (Modrinth .mrpack)
// ---------------------------------------------------------------------------

async function applyMrpack(dir, packFilePath, onProgress) {
  let zip;
  try {
    zip = new AdmZip(packFilePath);
  } catch (err) {
    throw new Error(`Modpack-Archiv konnte nicht gelesen werden: ${err.message}`);
  }
  const indexEntry = zip.getEntry('modrinth.index.json');
  if (!indexEntry) {
    throw new Error('Ungültiges Modrinth-Modpack: modrinth.index.json fehlt.');
  }
  let index;
  try {
    index = JSON.parse(indexEntry.getData().toString('utf8'));
  } catch (err) {
    throw new Error(`modrinth.index.json ist beschädigt: ${err.message}`);
  }

  const deps = index.dependencies || {};
  const mcVersion = deps.minecraft || null;
  const loader = mrpackLoader(deps);

  const allFiles = Array.isArray(index.files) ? index.files : [];
  // Skip files the author marked as unsupported on servers.
  const toInstall = allFiles.filter((f) => !(f.env && f.env.server === 'unsupported'));
  let skipped = allFiles.length - toInstall.length;
  let filesInstalled = 0;
  const total = allFiles.length;

  await runPool(toInstall, async (file) => {
    const url = Array.isArray(file.downloads) ? file.downloads[0] : null;
    const name = path.basename(String(file.path || 'file'));
    if (!url) {
      skipped += 1;
      onProgress(filesInstalled + skipped, total, name);
      return;
    }
    const target = safeJoin(dir, String(file.path || ''));
    await downloadToFile(url, target);
    filesInstalled += 1;
    onProgress(filesInstalled + skipped, total, name);
  });

  // Apply overrides (config files etc.); client-overrides are ignored.
  extractOverrides(zip, 'overrides', dir);

  return { filesInstalled, skipped, mcVersion, loader };
}

// ---------------------------------------------------------------------------
// Real pack application (CurseForge .zip)
// ---------------------------------------------------------------------------

async function fetchCurseforgeFileInfo(key, projectId, fileId) {
  let res;
  try {
    res = await fetch(`https://api.curseforge.com/v1/mods/${projectId}/files/${fileId}`, {
      headers: { 'x-api-key': key, Accept: 'application/json', 'User-Agent': DOWNLOAD_UA },
    });
  } catch (err) {
    throw new Error(`CurseForge nicht erreichbar: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`CurseForge API-Fehler: HTTP ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  return body && body.data ? body.data : null;
}

async function applyCurseforgeZip(dir, packFilePath, onProgress) {
  let zip;
  try {
    zip = new AdmZip(packFilePath);
  } catch (err) {
    throw new Error(`Modpack-Archiv konnte nicht gelesen werden: ${err.message}`);
  }
  const manifestEntry = zip.getEntry('manifest.json');
  if (!manifestEntry) {
    throw new Error('Ungültiges CurseForge-Modpack: manifest.json fehlt.');
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
  } catch (err) {
    throw new Error(`manifest.json ist beschädigt: ${err.message}`);
  }

  const mcVersion = manifest.minecraft && manifest.minecraft.version
    ? manifest.minecraft.version
    : null;
  const modLoaders = (manifest.minecraft && manifest.minecraft.modLoaders) || [];
  const primaryLoader = modLoaders.find((l) => l.primary) || modLoaders[0];
  const loader = primaryLoader && primaryLoader.id
    ? String(primaryLoader.id).split('-')[0].toLowerCase()
    : null;

  const files = (Array.isArray(manifest.files) ? manifest.files : []).filter(
    (f) => f.required !== false
  );
  const total = files.length;

  const key = curseforgeApiKey();
  if (!key && total > 0) {
    throw new Error(curseforge.NOT_CONFIGURED_MSG);
  }

  let filesInstalled = 0;
  let skipped = 0;

  await runPool(files, async (f) => {
    const fallbackName = `curseforge-${f.projectID}-${f.fileID}.jar`;
    let info = null;
    try {
      info = await fetchCurseforgeFileInfo(key, f.projectID, f.fileID);
    } catch (err) {
      // Unresolvable metadata: count as skipped, keep going.
      skipped += 1;
      onProgress(filesInstalled + skipped, total, fallbackName);
      return;
    }
    const fileName = path.basename(String((info && info.fileName) || fallbackName));
    const url = info && info.downloadUrl;
    if (!url) {
      // Author disabled third-party distribution.
      skipped += 1;
      onProgress(filesInstalled + skipped, total, fileName);
      return;
    }
    const target = safeJoin(path.join(dir, 'mods'), fileName);
    await downloadToFile(url, target);
    filesInstalled += 1;
    onProgress(filesInstalled + skipped, total, fileName);
  });

  // Apply overrides into the server root.
  extractOverrides(zip, manifest.overrides || 'overrides', dir);

  return { filesInstalled, skipped, mcVersion, loader };
}

// ---------------------------------------------------------------------------
// Public: apply a downloaded pack file to a server directory
// ---------------------------------------------------------------------------

async function applyPack({
  serverId,
  provider,
  packFilePath,
  jobId,
  onProgress,
  preparedServerPack = false,
  mcVersion = null,
  loader = null,
}) {
  const progress =
    typeof onProgress === 'function' ? onProgress : () => {};
  const dir = serverDir(serverId);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(packFilePath)) {
    throw new Error(`Modpack-Datei nicht gefunden: ${packFilePath}`);
  }
  if (provider === 'modrinth') return applyMrpack(dir, packFilePath, progress);
  if (provider === 'curseforge' && preparedServerPack) {
    return extractPreparedServerPack(packFilePath, dir, progress, { mcVersion, loader });
  }
  if (provider === 'curseforge') return applyCurseforgeZip(dir, packFilePath, progress);
  throw new Error(`Unbekannter Provider: ${provider}`);
}

// ---------------------------------------------------------------------------
// Install pipeline (standalone modpack install from the browser)
// ---------------------------------------------------------------------------

async function runJob(io, jobId, ctx) {
  ensureTables();
  const { serverId, provider, modpackId, versionId, name, iconUrl } = ctx;

  const setState = (patch) => {
    if (patch.status === 'running') {
      const current = getJob(jobId);
      if (current && current.status === 'aborted') throw new Error('ABORTED');
    }
    try {
      updateJob(jobId, patch);
    } catch (err) {
      console.error(`modpack job ${jobId}: failed to persist state:`, err.message);
    }
    if (io) {
      io.to(`server:${serverId}`).emit('modpack:progress', {
        jobId,
        serverId,
        percent: patch.percent != null ? patch.percent : null,
        stage: patch.stage != null ? patch.stage : null,
        status: patch.status != null ? patch.status : null,
        error: patch.error != null ? patch.error : null,
      });
    }
  };

  try {
    // 1. Resolve version + primary file (5%)
    setState({ status: 'running', stage: 'resolving', percent: 5 });
    const svc = PROVIDERS[provider];
    if (!svc) throw new Error(`Unknown provider: ${provider}`);

    const versions = await svc.getVersions(modpackId);
    if (!versions || !versions.length) {
      throw new Error('No versions available for this modpack');
    }
    const version =
      (versionId && versions.find((v) => String(v.id) === String(versionId))) || versions[0];
    let downloadVersion = version;
    let preparedServerPack = false;
    if (provider === 'curseforge' && version.serverPackFileId) {
      downloadVersion = await curseforge.getFile(modpackId, version.serverPackFileId);
      if (!downloadVersion) throw new Error('Offizielles CurseForge-Server-Pack nicht gefunden.');
      preparedServerPack = true;
    }
    const files = downloadVersion.files || [];
    const file = files.find((f) => f.primary && f.url) || files.find((f) => f.url) || files[0];
    if (!file || !file.url) {
      throw new Error('No downloadable file for this version (distribution disabled by author)');
    }

    // 2. Download the pack archive (5% -> 30%)
    const dir = modpackDir(serverId);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const filename = path.basename(file.filename || `modpack-${modpackId}-${downloadVersion.id}.zip`);
    const dest = path.join(dir, filename);
    await downloadWithProgress(
      file.url,
      dest,
      (pct) => {
        setState({ status: 'running', stage: 'downloading', percent: pct });
      },
      5,
      30
    );
    setState({ status: 'running', stage: 'applying', percent: 30 });

    // 3. REALLY apply the pack: download all mods + extract overrides (30% -> 95%)
    clearPackFiles(serverDir(serverId));
    const applyResult = await applyPack({
      serverId,
      provider,
      packFilePath: dest,
      jobId,
      preparedServerPack,
      mcVersion: version.mcVersion,
      loader: version.loader,
      onProgress: (done, total, currentName) => {
        const pct = 30 + (total ? (done / total) * 65 : 0);
        setState({
          status: 'running',
          stage: `Lade Mods (${done}/${total}): ${currentName}`,
          percent: Math.min(94.9, Math.round(pct * 10) / 10),
        });
      },
    });
    setState({ status: 'running', stage: 'registering', percent: 95 });

    // 4. Register the installed pack in the mods table (95% -> 100%)
    const packLoader = applyResult.loader || version.loader || null;
    const packMcVersion = applyResult.mcVersion || version.mcVersion || null;
    db.prepare(
      `INSERT OR REPLACE INTO mods (server_id, provider, provider_project_id, name, version, file_name, icon_url, mc_version, loader, installed_at, version_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      serverId,
      provider,
      String(modpackId),
      name || version.name,
      version.name,
      filename,
      iconUrl || null,
      packMcVersion,
      packLoader,
      now(),
      String(version.id)
    );

    // Best-effort: update the server row to reflect the pack's loader/MC version.
    try {
      db.prepare('UPDATE servers SET loader = ?, version = ? WHERE id = ?').run(
        packLoader,
        packMcVersion,
        serverId
      );
    } catch (_) {
      /* non-fatal */
    }

    // Safety net: if the server is already installed with a different loader,
    // don't fail the job — just flag it in the final stage text.
    let doneStage = 'done';
    try {
      const installer = require('./installerService');
      if (installer.isInstalled(serverId)) {
        const srv = db.prepare('SELECT loader FROM servers WHERE id = ?').get(serverId);
        if (
          srv &&
          srv.loader &&
          packLoader &&
          String(srv.loader).toLowerCase() !== String(packLoader).toLowerCase()
        ) {
          doneStage = 'done — Achtung: Server läuft mit anderem Loader';
        }
      }
    } catch (_) {
      /* non-fatal */
    }

    // 5. Done (100%)
    setState({ status: 'done', stage: doneStage, percent: 100, error: null });
  } catch (err) {
    if (err.message === 'ABORTED') {
      setState({ status: 'aborted', stage: 'aborted', error: 'Vom Administrator abgebrochen' });
      return;
    }
    console.error(`modpack job ${jobId} failed:`, err.message);
    setState({ status: 'error', stage: 'error', error: err.message });
  }
}

module.exports = { createJob, runJob, getJob, abortJob, listJobs, listMods, removeMod, applyPack };
