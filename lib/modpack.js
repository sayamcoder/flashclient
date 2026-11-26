const fs = require('fs');
const path = require('path');
const profiles = require('./profiles');
const { download, mapLimit } = require('./net');
const { extractZip, readZipEntry } = require('./zip');

/* Modrinth modpacks (.mrpack). A pack is a zip with a modrinth.index.json that
   lists every file by URL + sha512, plus overrides/ for configs and anything
   that is not hosted on Modrinth. Installing one creates a normal profile, so
   Play, RAM and Java settings all keep working the way they already do. */

const API = 'https://api.modrinth.com/v2';
const USER_AGENT = 'FlashClient/1.0.4 (Minecraft launcher)';
const PACK_FILE = 'pack.json';

const LOADERS = {
  'fabric-loader': 'fabric',
  forge: 'forge',
  neoforge: 'neoforge'
};

async function request(pathname) {
  const res = await fetch(`${API}${pathname}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) {
    throw new Error(res.status === 404 ? 'Not available on Modrinth.' : `Modrinth responded ${res.status}.`);
  }
  return res.json();
}

/* /search wants facets as nested arrays, while the version listing takes a
   flat JSON array per filter — encoding both the same way made Modrinth ignore
   the filter and hand back the newest build for another game version. */
function jsonArray(values) {
  return encodeURIComponent(JSON.stringify(values));
}

async function search({ query = '', gameVersion, loader, limit = 30 } = {}) {
  if (!gameVersion || !loader) throw new Error('Pick a profile first.');

  const facets = [['project_type:modpack'], [`versions:${gameVersion}`]];
  if (loader !== 'vanilla') facets.push([`categories:${loader}`]);

  const params = new URLSearchParams({
    query,
    limit: String(Math.min(Math.max(limit, 1), 40)),
    index: query ? 'relevance' : 'downloads',
    facets: JSON.stringify(facets)
  });

  const data = await request(`/search?${params}`);
  return {
    total: data.total_hits || 0,
    packs: (data.hits || []).map((hit) => ({
      id: hit.project_id,
      slug: hit.slug,
      title: hit.title,
      description: hit.description,
      author: hit.author,
      downloads: hit.downloads,
      followers: hit.follows,
      icon: hit.icon_url
    }))
  };
}

/* The newest pack build that matches the profile's version + loader. */
async function versionFor(projectId, { gameVersion, loader }) {
  const versions = await request(
    `/project/${encodeURIComponent(projectId)}/version?loaders=${jsonArray([loader])}&game_versions=${jsonArray([gameVersion])}`
  );
  const list = Array.isArray(versions) ? versions : [];
  // A pack that just pushed an alpha still has a stable build most players
  // expect; only fall back to test builds when nothing else matches.
  return list.find((v) => v.version_type === 'release')
    || list.find((v) => v.version_type === 'beta')
    || list[0]
    || null;
}

function packMeta(profileId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(profiles.instanceDir(profileId), PACK_FILE), 'utf8'));
  } catch (err) {
    return null;
  }
}

function installedProjects() {
  const out = [];
  for (const profile of profiles.list()) {
    const meta = packMeta(profile.id);
    if (meta?.projectId) out.push({ projectId: meta.projectId, profileId: profile.id, name: meta.name || profile.name });
  }
  return out;
}

/* Pack paths are relative to the game folder; anything that escapes it is
   refused instead of being written somewhere else on disk. */
function safeRelative(value) {
  const raw = String(value || '').replace(/\\/g, '/').trim();
  if (!raw || raw.startsWith('/') || /^[a-z]:/i.test(raw)) return null;
  const normal = path.posix.normalize(raw);
  if (normal.startsWith('..') || normal === '.') return null;
  return normal;
}

function readIndex(packPath) {
  const raw = readZipEntry(packPath, 'modrinth.index.json');
  if (!raw) throw new Error('That pack has no modrinth.index.json.');
  const index = JSON.parse(raw.toString('utf8'));
  if (!index || index.formatVersion !== 1 || !Array.isArray(index.files)) {
    throw new Error('Unsupported pack format.');
  }
  return index;
}

function dependencyInfo(index) {
  const deps = index.dependencies || {};
  const key = Object.keys(LOADERS).find((name) => typeof deps[name] === 'string');
  const gameVersion = typeof deps.minecraft === 'string' ? deps.minecraft : '';
  if (!key) {
    if (typeof deps['quilt-loader'] === 'string') throw new Error('Quilt packs are not supported yet.');
    throw new Error('This pack has no supported mod loader.');
  }
  if (!gameVersion) throw new Error('This pack does not name a Minecraft version.');
  return { loader: LOADERS[key], loaderVersion: deps[key], gameVersion };
}

async function install({ projectId, versionId, gameVersion, loader, ram, onProgress }) {
  if (!projectId) throw new Error('Missing pack.');

  const project = await request(`/project/${encodeURIComponent(projectId)}`);
  const version = versionId
    ? await request(`/version/${encodeURIComponent(versionId)}`)
    : await versionFor(projectId, { gameVersion, loader });
  if (!version) throw new Error('No build of this pack matches that version and loader.');

  const file = (version.files || []).find((entry) => entry.primary) || (version.files || [])[0];
  if (!file?.url) throw new Error('This pack build has no downloadable file.');

  const created = profiles.create({
    name: `${project.title} ${version.version_number}`.trim().slice(0, 64),
    gameVersion: gameVersion || project.game_versions?.[0] || '1.21.1',
    loader: loader || 'fabric',
    ram
  });

  const gameDir = profiles.gameDir(created.id);
  const packPath = path.join(profiles.instanceDir(created.id), '.pack.mrpack');
  const cleanup = () => {
    try { fs.rmSync(profiles.instanceDir(created.id), { recursive: true, force: true }); } catch (err) { /* best effort */ }
    profiles.remove(created.id);
  };

  try {
    onProgress?.({ phase: 'pack', done: 0, total: 1, message: `Downloading ${project.title}…` });
    fs.mkdirSync(path.dirname(packPath), { recursive: true });
    await download(file.url, packPath, { sha512: file.hashes?.sha512, expectedSize: file.size });
    onProgress?.({ phase: 'pack', done: 1, total: 1, message: 'Reading pack…' });

    const index = readIndex(packPath);
    const deps = dependencyInfo(index);

    // The pack says which version and loader it was built for; that wins over
    // whatever the browse scope happened to be.
    profiles.update(created.id, {
      gameVersion: deps.gameVersion,
      loader: deps.loader,
      loaderVersion: deps.loaderVersion
    });

    const want = index.files.filter((entry) => safeRelative(entry.path) && entry.env?.client !== 'unsupported');
    let done = 0;
    let bytes = 0;

    await mapLimit(want, 6, async (entry) => {
      const rel = safeRelative(entry.path);
      const url = (entry.downloads || [])[0];
      if (!url) throw new Error(`Pack file has no download: ${rel}`);

      const result = await download(url, path.join(gameDir, rel), {
        sha512: entry.hashes?.sha512,
        expectedSize: entry.fileSize
      });
      bytes += result.bytes || 0;
      done += 1;
      onProgress?.({
        phase: 'files',
        done,
        total: want.length,
        message: `${done} of ${want.length} files`,
        ratio: want.length ? done / want.length : 1
      });
    });

    onProgress?.({ phase: 'overrides', done: 0, total: 1, message: 'Unpacking configs…' });
    extractZip(packPath, gameDir, {
      remap: (name) => {
        if (name.startsWith('overrides/')) return name.slice('overrides/'.length);
        if (name.startsWith('client-overrides/')) return name.slice('client-overrides/'.length);
        return null;
      }
    });

    fs.mkdirSync(profiles.instanceDir(created.id), { recursive: true });
    fs.writeFileSync(
      path.join(profiles.instanceDir(created.id), PACK_FILE),
      JSON.stringify({
        projectId: project.id,
        slug: project.slug,
        versionId: version.id,
        versionNumber: version.version_number,
        name: project.title,
        icon: project.icon_url || null,
        installedAt: Date.now()
      }, null, 2)
    );

    return {
      profileId: created.id,
      name: project.title,
      icon: project.icon_url || null,
      versionNumber: version.version_number,
      gameVersion: deps.gameVersion,
      loader: deps.loader,
      files: want.length,
      bytes
    };
  } catch (err) {
    cleanup();
    throw err;
  } finally {
    fs.rmSync(packPath, { force: true });
  }
}

module.exports = { search, install, installedProjects };
