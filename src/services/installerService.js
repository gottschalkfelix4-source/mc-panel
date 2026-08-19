// Server installer pipeline: downloads & installs vanilla/paper/fabric/forge/neoforge
// server software into <SERVERS_DIR>/<id>/ and tracks progress as a job row in the
// existing modpack_jobs table (provider='installer'). Progress is streamed to
// clients via the socket.io event 'modpack:progress'.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { db, now } = require('./database');
const modrinth = require('./modrinthService');
const curseforge = require('./curseforgeService');

const UA = 'MCHostingPanel/1.0';
const MODPACK_PROVIDERS = { modrinth, curseforge };

// Entries kept when a server is wiped before a reinstall.
const WIPE_KEEP = new Set([
  'world',
  'world_nether',
  'world_the_end',
  'eula.txt',
  'server.properties',
  'ops.json',
  'whitelist.json',
  'usercache.json',
]);

function wipeKeepEntry(name) {
  return WIPE_KEEP.has(name) || (name.startsWith('banned-') && name.endsWith('.json'));
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

const LOADERS = [
  { id: 'vanilla', name: 'Vanilla', description: 'Offizieller Minecraft-Server von Mojang' },
  { id: 'paper', name: 'Paper', description: 'Performanter Server mit Plugin-Support (Bukkit/Spigot-API)' },
  { id: 'fabric', name: 'Fabric', description: 'Leichtgewichtiger Mod-Loader für Fabric-Mods' },
  { id: 'forge', name: 'Forge', description: 'Klassischer Mod-Loader mit großem Mod-Ökosystem' },
  { id: 'neoforge', name: 'NeoForge', description: 'Moderner Forge-Fork für aktuelle Minecraft-Versionen' },
];

function normalizeLoader(value) {
  const compact = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (compact === 'quilt') return 'fabric';
  if (compact === 'neoforge') return 'neoforge';
  return compact;
}

function getLoaders() {
  return LOADERS.map((l) => ({ ...l }));
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function fetchJson(url) {
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA } });
  } catch (err) {
    throw new Error(`Netzwerkfehler bei ${url}: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} bei ${url}`);
  }
  return res.json();
}

async function fetchText(url) {
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA } });
  } catch (err) {
    throw new Error(`Netzwerkfehler bei ${url}: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} bei ${url}`);
  }
  return res.text();
}

// Semver-ish comparison for MC versions like '1.20', '1.21.1' (numeric parts).
function compareVersionsDesc(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return -d; // newest first
  }
  return 0;
}

// True when version a >= version b (numeric dotted compare).
function versionGte(a, b) {
  return compareVersionsDesc(a, b) <= 0;
}

// ---------------------------------------------------------------------------
// Version lists (live from official APIs)
// ---------------------------------------------------------------------------

async function getVersions(loader) {
  loader = normalizeLoader(loader);
  switch (loader) {
    case 'vanilla': {
      const manifest = await fetchJson(
        'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
      );
      return (manifest.versions || []).filter((v) => v.type === 'release').map((v) => v.id);
    }
    case 'paper': {
      // PaperMC API v3 (v2 is retired). versions: { '<major>': ['<ver>', ...] }, newest first.
      const data = await fetchJson('https://fill.papermc.io/v3/projects/paper');
      const all = Object.values(data.versions || {}).flat();
      return all
        .filter((v) => /^\d/.test(v) && !v.includes('-') && versionGte(v, '1.16'))
        .sort(compareVersionsDesc);
    }
    case 'fabric': {
      const data = await fetchJson('https://meta.fabricmc.net/v2/versions/game');
      return (data || []).filter((v) => v.stable === true).map((v) => v.version);
    }
    case 'forge': {
      const data = await fetchJson(
        'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'
      );
      const mcVersions = new Set();
      for (const key of Object.keys(data.promos || {})) {
        if (key.endsWith('-latest')) {
          mcVersions.add(key.slice(0, -'-latest'.length));
        }
      }
      return [...mcVersions].filter((v) => versionGte(v, '1.17')).sort(compareVersionsDesc);
    }
    case 'neoforge': {
      const xml = await fetchText(
        'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml'
      );
      const neoVersions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
      const mcVersions = new Set();
      for (const neo of neoVersions) {
        const parts = neo.split('.');
        if (parts.length < 2) continue;
        mcVersions.add(`1.${parts[0]}.${parts[1]}`);
      }
      return [...mcVersions].sort(compareVersionsDesc);
    }
    default:
      throw new Error(`Unbekannter Loader: ${loader}`);
  }
}

// ---------------------------------------------------------------------------
// Paths / state
// ---------------------------------------------------------------------------

function serverDir(serverId) {
  const base = path.resolve(process.cwd(), process.env.SERVERS_DIR || './servers');
  return path.join(base, String(serverId));
}

function runJsonPath(serverId) {
  return path.join(serverDir(serverId), 'run.json');
}

function isInstalled(serverId) {
  try {
    const row = db.prepare('SELECT installed FROM servers WHERE id = ?').get(serverId);
    if (!row || row.installed !== 1) return false;
    return fs.existsSync(runJsonPath(serverId));
  } catch (_) {
    return false;
  }
}

function getRunConfig(serverId) {
  const file = runJsonPath(serverId);
  if (!fs.existsSync(file)) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { workDir: serverDir(serverId), ...cfg };
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Job helpers
// ---------------------------------------------------------------------------

function createJobRow({ serverId, loader, mcVersion }) {
  const jobId = crypto.randomUUID();
  const ts = now();
  db.prepare(
    `INSERT INTO modpack_jobs (id, server_id, provider, modpack_id, name, status, percent, stage, error, created_at, updated_at)
     VALUES (?, ?, 'installer', ?, ?, 'queued', 0, 'Warteschlange', NULL, ?, ?)`
  ).run(jobId, serverId, loader, `${loader} ${mcVersion}`, ts, ts);
  return jobId;
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
// Resolution: download URL(s) + run.json config per loader
// ---------------------------------------------------------------------------

async function resolveInstall(loader, mcVersion) {
  loader = normalizeLoader(loader);
  switch (loader) {
    case 'vanilla': {
      const manifest = await fetchJson(
        'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
      );
      const entry = (manifest.versions || []).find((v) => v.id === mcVersion);
      if (!entry) throw new Error(`Minecraft-Version ${mcVersion} nicht gefunden.`);
      const detail = await fetchJson(entry.url);
      const url = detail.downloads && detail.downloads.server && detail.downloads.server.url;
      if (!url) throw new Error(`Kein Server-Download für Minecraft ${mcVersion} verfügbar.`);
      return {
        files: [{ url, filename: 'server.jar' }],
        runConfig: { type: 'jar', jar: 'server.jar', mcVersion, loader },
        installerFile: null,
      };
    }
    case 'paper': {
      // PaperMC API v3: builds listed newest first, direct download URL included.
      const builds = await fetchJson(
        `https://fill.papermc.io/v3/projects/paper/versions/${mcVersion}/builds`
      );
      const build = (builds || [])
        .filter((b) => b.downloads && b.downloads['server:default'])
        .sort((a, b) => b.id - a.id)[0];
      if (!build) {
        throw new Error(`Keine Paper-Builds für Minecraft ${mcVersion} gefunden.`);
      }
      return {
        files: [{ url: build.downloads['server:default'].url, filename: 'server.jar' }],
        runConfig: { type: 'jar', jar: 'server.jar', mcVersion, loader },
        installerFile: null,
      };
    }
    case 'fabric': {
      const loaders = await fetchJson('https://meta.fabricmc.net/v2/versions/loader');
      const loaderEntry = (loaders || []).find((l) => l.stable === true);
      if (!loaderEntry) throw new Error('Kein stabiler Fabric-Loader gefunden.');
      const installers = await fetchJson('https://meta.fabricmc.net/v2/versions/installer');
      const installerEntry = (installers || []).find((i) => i.stable === true);
      if (!installerEntry) throw new Error('Kein stabiler Fabric-Installer gefunden.');
      return {
        files: [
          {
            url: `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loaderEntry.version}/${installerEntry.version}/server/jar`,
            filename: 'server.jar',
          },
        ],
        runConfig: { type: 'jar', jar: 'server.jar', mcVersion, loader },
        installerFile: null,
      };
    }
    case 'forge': {
      const data = await fetchJson(
        'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'
      );
      const promos = data.promos || {};
      const forgeVer = promos[`${mcVersion}-latest`] || promos[`${mcVersion}-recommended`];
      if (!forgeVer) {
        throw new Error(`Kein Forge-Build für Minecraft ${mcVersion} verfügbar.`);
      }
      const installerFile = 'forge-installer.jar';
      return {
        files: [
          {
            url: `https://maven.minecraftforge.net/net/minecraftforge/forge/${mcVersion}-${forgeVer}/forge-${mcVersion}-${forgeVer}-installer.jar`,
            filename: installerFile,
          },
        ],
        runConfig: {
          type: 'args',
          argsFile: `libraries/net/minecraftforge/forge/${mcVersion}-${forgeVer}/unix_args.txt`,
          mcVersion,
          loader,
        },
        installerFile,
      };
    }
    case 'neoforge': {
      const xml = await fetchText(
        'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml'
      );
      const neoVersions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
      // MC '1.21.1' -> neoforge prefix '21.1.'; MC '1.21' -> '21.0.' (fallback '21.').
      // Modern MC versions dropped the '1.' prefix ('26.2' -> prefix '26.2.').
      const stripped = mcVersion.startsWith('1.') ? mcVersion.slice(2) : mcVersion;
      const mcParts = stripped.split('.');
      const prefixes =
        mcParts.length >= 2 ? [`${mcParts[0]}.${mcParts[1]}.`] : [`${mcParts[0]}.0.`, `${mcParts[0]}.`];
      let neoVer = null;
      for (const prefix of prefixes) {
        const matches = neoVersions.filter((v) => v.startsWith(prefix));
        if (matches.length) {
          neoVer = matches.sort(compareVersionsDesc)[0];
          break;
        }
      }
      if (!neoVer) {
        throw new Error(`Kein NeoForge-Build für Minecraft ${mcVersion} verfügbar.`);
      }
      const installerFile = 'neoforge-installer.jar';
      return {
        files: [
          {
            url: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${neoVer}/neoforge-${neoVer}-installer.jar`,
            filename: installerFile,
          },
        ],
        runConfig: {
          type: 'args',
          argsFile: `libraries/net/neoforged/neoforge/${neoVer}/unix_args.txt`,
          mcVersion,
          loader,
        },
        installerFile,
      };
    }
    default:
      throw new Error(`Unbekannter Loader: ${loader}`);
  }
}

// ---------------------------------------------------------------------------
// Download with progress (streams, MB label, fake crawl when size unknown)
// ---------------------------------------------------------------------------

function formatMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1).replace('.', ',');
}

async function downloadFile(url, dest, onProgress) {
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA } });
  } catch (err) {
    throw new Error(`Download fehlgeschlagen: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`Download fehlgeschlagen: HTTP ${res.status} ${res.statusText}`);
  }

  const total = Number(res.headers.get('content-length')) || 0;
  const chunks = [];
  let received = 0;

  // Unknown size: smooth fake crawl of the fraction up to 0.92.
  let fakeTimer = null;
  if (!total) {
    let fake = 0;
    fakeTimer = setInterval(() => {
      fake = Math.min(0.92, fake + Math.max(0.005, (0.92 - fake) * 0.06));
      onProgress(fake, 0);
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
        if (total) onProgress(received / total, received);
      }
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      chunks.push(buf);
      received = buf.length;
    }
  } catch (err) {
    throw new Error(`Download unterbrochen: ${err.message}`);
  } finally {
    if (fakeTimer) clearInterval(fakeTimer);
  }

  fs.writeFileSync(dest, Buffer.concat(chunks, received));
  onProgress(1, received);
}

// ---------------------------------------------------------------------------
// Forge/NeoForge installer subprocess
// ---------------------------------------------------------------------------

function runJavaInstaller(installerPath, cwd, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn('java', ['-jar', installerPath, '--installServer'], { cwd });
    let lastUpdate = 0;
    let buf = '';

    const handleData = (data) => {
      buf += data.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        const text = line.trim();
        if (!text) continue;
        const t = Date.now();
        if (t - lastUpdate >= 500) {
          // throttle to ~2 updates/s
          lastUpdate = t;
          onLine(text.slice(0, 140));
        }
      }
    };

    child.stdout.on('data', handleData);
    child.stderr.on('data', handleData);
    child.on('error', (err) => {
      reject(
        new Error(
          `Java konnte nicht gestartet werden (${err.message}). Ist Java installiert und im PATH?`
        )
      );
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Installer mit Exit-Code ${code} fehlgeschlagen.`));
    });
  });
}

// ---------------------------------------------------------------------------
// Configuration files
// ---------------------------------------------------------------------------

function writeConfiguration(dir, { port, serverName, runConfig, needsJvmArgs }) {
  // EULA
  fs.writeFileSync(
    path.join(dir, 'eula.txt'),
    `# Minecraft EULA\n# Akzeptiert durch das Panel am ${new Date().toISOString()}\neula=true\n`
  );

  // server.properties: never clobber an existing port, only ensure it is set.
  const propsPath = path.join(dir, 'server.properties');
  if (fs.existsSync(propsPath)) {
    const content = fs.readFileSync(propsPath, 'utf8');
    if (!/^server-port\s*=/m.test(content)) {
      fs.appendFileSync(propsPath, `\nserver-port=${port}\n`);
    }
  } else {
    fs.writeFileSync(
      propsPath,
      [
        `server-port=${port}`,
        `motd=${serverName || 'Minecraft Server'}`,
        'sync-chunk-writes=true',
        'enable-query=false',
        '',
      ].join('\n')
    );
  }

  // run.json consumed by the process manager
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(runConfig, null, 2));

  if (needsJvmArgs) {
    const jvmArgs = path.join(dir, 'user_jvm_args.txt');
    if (!fs.existsSync(jvmArgs)) fs.writeFileSync(jvmArgs, '');
  }
}

// ---------------------------------------------------------------------------
// Install pipeline
// ---------------------------------------------------------------------------

async function runInstall(io, jobId, ctx) {
  const { serverId, mcVersion, port, wipe, modpack } = ctx;
  const loader = normalizeLoader(ctx.loader);
  const hasModpack = Boolean(modpack);

  const setState = (patch) => {
    try {
      updateJob(jobId, patch);
    } catch (err) {
      console.error(`installer job ${jobId}: failed to persist state:`, err.message);
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
    const dir = serverDir(serverId);
    fs.mkdirSync(dir, { recursive: true });

    // 0. Wipe the server directory first, keeping the world + core config.
    if (wipe === true) {
      setState({
        status: 'running',
        stage: 'Setze Server zurück (Welt bleibt erhalten)',
        percent: 0,
      });
      for (const entry of fs.readdirSync(dir)) {
        if (wipeKeepEntry(entry)) continue;
        fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
      }
      setState({
        status: 'running',
        stage: 'Setze Server zurück (Welt bleibt erhalten)',
        percent: 5,
      });
    }

    // 1. Resolve download URLs + loader version (5%)
    setState({ status: 'running', stage: 'resolving', percent: 5 });
    const resolved = await resolveInstall(loader, mcVersion);

    // Progress budget: without a modpack configuring ends at 97%;
    // with a modpack it ends at 70% and the pack application follows.
    const dlEnd = hasModpack ? 45 : 60;
    const installEnd = hasModpack ? 65 : 90;
    const cfgEnd = hasModpack ? 70 : 97;

    // 2. Download files (5% -> dlEnd)
    const range = dlEnd - 5;
    const perFile = range / resolved.files.length;
    for (let i = 0; i < resolved.files.length; i++) {
      const file = resolved.files[i];
      const startPct = 5 + i * perFile;
      const dest = path.join(dir, path.basename(file.filename));
      await downloadFile(file.url, dest, (fraction, received) => {
        const pct = Math.min(dlEnd - 0.1, Math.round((startPct + fraction * perFile) * 10) / 10);
        const mb = received ? ` (${formatMB(received)} MB)` : '';
        setState({
          status: 'running',
          stage: `Lade ${path.basename(file.filename)}${mb}`,
          percent: pct,
        });
      });
    }
    setState({ status: 'running', stage: 'downloading', percent: dlEnd });

    // 3. Run the installer for forge/neoforge (dlEnd -> installEnd)
    if (resolved.installerFile) {
      let tick = 0;
      await runJavaInstaller(path.join(dir, resolved.installerFile), dir, (line) => {
        tick += 1;
        setState({
          status: 'running',
          stage: line,
          percent: Math.min(installEnd - 1, dlEnd + tick * 0.5),
        });
      });
    }
    setState({ status: 'running', stage: 'installing', percent: installEnd });

    // 4. Write configuration files (installEnd -> cfgEnd)
    setState({ status: 'running', stage: 'configuring', percent: installEnd + (cfgEnd - installEnd) * 0.4 });
    let serverName = null;
    try {
      const row = db.prepare('SELECT name FROM servers WHERE id = ?').get(serverId);
      serverName = row ? row.name : null;
    } catch (_) {
      /* non-fatal */
    }
    writeConfiguration(dir, {
      port,
      serverName,
      runConfig: resolved.runConfig,
      needsJvmArgs: loader === 'forge' || loader === 'neoforge',
    });
    setState({ status: 'running', stage: 'configuring', percent: cfgEnd });

    // 5. Optional modpack chain: download pack file, then REALLY apply it
    //    (all mods + overrides), then register it (70% -> 97%).
    if (hasModpack) {
      setState({ status: 'running', stage: 'modpack', percent: 70 });
      const svc = MODPACK_PROVIDERS[modpack.provider];
      if (!svc) throw new Error(`Unbekannter Modpack-Provider: ${modpack.provider}`);
      const versions = await svc.getVersions(String(modpack.modpackId));
      const packVersion =
        (modpack.versionId &&
          (versions || []).find((v) => String(v.id) === String(modpack.versionId))) ||
        (versions || [])[0];
      if (!packVersion) {
        throw new Error('Keine Version für dieses Modpack gefunden.');
      }
      let downloadVersion = packVersion;
      let preparedServerPack = false;
      if (modpack.provider === 'curseforge' && packVersion.serverPackFileId) {
        downloadVersion = await curseforge.getFile(
          String(modpack.modpackId),
          packVersion.serverPackFileId
        );
        if (!downloadVersion) {
          throw new Error('Offizielles CurseForge-Server-Pack nicht gefunden.');
        }
        preparedServerPack = true;
      }
      const packFiles = downloadVersion.files || [];
      const packFile =
        packFiles.find((f) => f.primary && f.url) || packFiles.find((f) => f.url);
      if (!packFile || !packFile.url) {
        throw new Error('Kein Download für diese Modpack-Version verfügbar.');
      }

      // 5a. Download the pack archive (70% -> 80%)
      const packsDir = path.join(dir, 'modpacks');
      fs.rmSync(packsDir, { recursive: true, force: true });
      fs.mkdirSync(packsDir, { recursive: true });
      const packFilename = path.basename(
        packFile.filename || `modpack-${modpack.modpackId}-${downloadVersion.id}.zip`
      );
      const packDest = path.join(packsDir, packFilename);
      await downloadFile(packFile.url, packDest, (fraction, received) => {
        const pct = Math.min(79.9, Math.round((70 + fraction * 10) * 10) / 10);
        const mb = received ? ` (${formatMB(received)} MB)` : '';
        setState({
          status: 'running',
          stage: `Lade Modpack ${packFilename}${mb}`,
          percent: pct,
        });
      });
      setState({ status: 'running', stage: 'modpack', percent: 80 });

      // 5b. Apply the pack: download all mods + extract overrides (80% -> 97%)
      const modpackService = require('./modpackService'); // lazy: avoids a require cycle
      const applyResult = await modpackService.applyPack({
        serverId,
        provider: modpack.provider,
        packFilePath: packDest,
        jobId,
        preparedServerPack,
        mcVersion: packVersion.mcVersion,
        loader: packVersion.loader,
        onProgress: (done, total, currentName) => {
          const pct = 80 + (total ? (done / total) * 17 : 0);
          setState({
            status: 'running',
            stage: `Lade Mods (${done}/${total}): ${currentName}`,
            percent: Math.min(96.9, Math.round(pct * 10) / 10),
          });
        },
      });

      // 5c. Register the pack in the mods table
      db.prepare(
        `INSERT OR REPLACE INTO mods (server_id, provider, provider_project_id, name, version, file_name, icon_url, mc_version, loader, installed_at, version_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        serverId,
        modpack.provider,
        String(modpack.modpackId),
        modpack.name || packVersion.name,
        packVersion.name,
        packFilename,
        modpack.iconUrl || null,
        applyResult.mcVersion || packVersion.mcVersion || null,
        applyResult.loader || packVersion.loader || null,
        now(),
        String(packVersion.id)
      );
      setState({ status: 'running', stage: 'modpack', percent: 97 });
    }

    // 6. Mark server as installed (100%)
    db.prepare('UPDATE servers SET installed = 1, version = ?, loader = ? WHERE id = ?').run(
      mcVersion,
      loader,
      serverId
    );
    setState({ status: 'done', stage: 'done', percent: 100, error: null });
  } catch (err) {
    console.error(`installer job ${jobId} failed:`, err.message);
    setState({ status: 'error', stage: 'error', error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function createInstallJob(io, { serverId, loader, mcVersion, port, wipe, modpack }) {
  loader = normalizeLoader(loader);
  // A chained modpack dictates loader + mcVersion; both must be present.
  if (modpack && (!loader || !mcVersion)) {
    throw new Error('Modpack-Installation benötigt Loader und Minecraft-Version.');
  }
  const jobId = createJobRow({ serverId, loader, mcVersion });
  setImmediate(() => {
    runInstall(io, jobId, { serverId, loader, mcVersion, port, wipe, modpack }).catch((err) => {
      // runInstall already catches everything; this is a last-resort guard.
      console.error(`installer job ${jobId} crashed:`, err);
    });
  });
  return jobId;
}

module.exports = { getLoaders, getVersions, isInstalled, getRunConfig, createInstallJob };
