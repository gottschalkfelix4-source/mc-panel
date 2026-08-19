// CurseForge API v1 service (requires CURSEFORGE_API_KEY env var)
// Docs: https://docs.curseforge.com/

const BASE_URL = 'https://api.curseforge.com/v1';
const GAME_ID = 432; // Minecraft
const CLASS_ID = 4471; // Modpacks
const NOT_CONFIGURED_MSG = 'CURSEFORGE_API_KEY not configured';

const KNOWN_LOADERS = ['forge', 'fabric', 'quilt', 'neoforge'];

function apiKey() {
  // DB (settings page) takes precedence over env var; lazy-require to avoid
  // a circular dependency at module load time.
  try {
    const settings = require('./settingsService');
    const fromDb = settings.get(settings.KEYS.CURSEFORGE_API_KEY);
    if (fromDb) return fromDb;
  } catch {
    // settings table not ready yet — fall through to env
  }
  return process.env.CURSEFORGE_API_KEY || null;
}

function isConfigured() {
  return Boolean(apiKey());
}

async function request(path) {
  const key = apiKey();
  if (!key) {
    throw new Error(NOT_CONFIGURED_MSG);
  }
  let res;
  try {
    res = await fetch(BASE_URL + path, {
      headers: {
        'x-api-key': key,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    throw new Error(`CurseForge API unreachable: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`CurseForge API error: HTTP ${res.status} ${res.statusText}`);
  }
  try {
    return await res.json();
  } catch (err) {
    throw new Error(`CurseForge API returned invalid JSON: ${err.message}`);
  }
}

// Search modpacks. Returns same shape as modrinthService.searchModpacks.
async function searchModpacks(query, limit = 20, offset = 0) {
  const params = new URLSearchParams({
    gameId: String(GAME_ID),
    classId: String(CLASS_ID),
    searchFilter: query || '',
    pageSize: String(limit),
    index: String(offset),
    sortField: '2', // Popularity
    sortOrder: 'desc',
  });
  const data = await request(`/mods/search?${params.toString()}`);
  return (data.data || []).map((m) => ({
    id: String(m.id),
    slug: m.slug,
    name: m.name,
    author: m.authors && m.authors[0] ? m.authors[0].name : undefined,
    description: m.summary,
    downloads: m.downloadCount,
    iconUrl: m.logo ? m.logo.thumbnailUrl : undefined,
    mcVersions: (m.latestFilesIndexes || [])
      .map((f) => f.gameVersion)
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 6),
  }));
}

function mapVersion(f) {
  return {
    id: String(f.id),
    name: f.displayName,
    mcVersion: (f.gameVersions || [])[0],
    loader: String(
      (f.gameVersions || []).find((v) => KNOWN_LOADERS.includes(String(v).toLowerCase())) ||
        'forge'
    ).toLowerCase(),
    date: f.fileDate,
    serverPackFileId: f.serverPackFileId ? String(f.serverPackFileId) : null,
    isServerPack: Boolean(f.isServerPack),
    files: [
      {
        url: f.downloadUrl,
        filename: f.fileName,
        size: f.fileLength,
        primary: true,
      },
    ],
  };
}

// Get files (versions) of a modpack. Returns same shape as modrinthService.getVersions.
// Note: f.downloadUrl may be null for files whose authors disabled distribution; kept as null.
async function getVersions(projectId) {
  const data = await request(`/mods/${encodeURIComponent(projectId)}/files?pageSize=25`);
  return (data.data || []).filter((f) => !f.isServerPack).map(mapVersion);
}

async function getFile(projectId, fileId) {
  const data = await request(
    `/mods/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}`
  );
  return data.data ? mapVersion(data.data) : null;
}

module.exports = { isConfigured, searchModpacks, getVersions, getFile, NOT_CONFIGURED_MSG };
