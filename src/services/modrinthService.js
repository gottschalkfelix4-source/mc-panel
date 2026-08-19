// Modrinth API v2 service (no API key required)
// Docs: https://docs.modrinth.com/api/

const BASE_URL = 'https://api.modrinth.com/v2';
const USER_AGENT = 'MinecraftHostingPanel/1.0 (panel demo)';

async function request(path) {
  let res;
  try {
    res = await fetch(BASE_URL + path, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    throw new Error(`Modrinth API unreachable: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`Modrinth API error: HTTP ${res.status} ${res.statusText}`);
  }
  try {
    return await res.json();
  } catch (err) {
    throw new Error(`Modrinth API returned invalid JSON: ${err.message}`);
  }
}

// Search modpacks. Returns [{id, slug, name, author, description, downloads, iconUrl, mcVersions}]
async function searchModpacks(query, limit = 20, offset = 0) {
  const facets = encodeURIComponent(JSON.stringify([['project_type:modpack']]));
  const params = new URLSearchParams({
    query: query || '',
    limit: String(limit),
    offset: String(offset),
  });
  const data = await request(`/search?${params.toString()}&facets=${facets}`);
  return (data.hits || []).map((h) => ({
    id: h.project_id,
    slug: h.slug,
    name: h.title,
    author: h.author,
    description: h.description,
    downloads: h.downloads,
    iconUrl: h.icon_url,
    mcVersions: h.versions,
  }));
}

// Get versions of a project. Returns [{id, name, mcVersion, loader, date, files:[{url, filename, size, primary}]}]
async function getVersions(projectId) {
  const data = await request(`/project/${encodeURIComponent(projectId)}/version`);
  return (data || []).map((v) => ({
    id: v.id,
    name: v.name,
    mcVersion: (v.game_versions || [])[0],
    loader: (v.loaders || [])[0],
    date: v.date_published,
    files: (v.files || []).map((f) => ({
      url: f.url,
      filename: f.filename,
      size: f.size,
      primary: f.primary,
    })),
  }));
}

module.exports = { searchModpacks, getVersions };
