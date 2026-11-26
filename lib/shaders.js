const fs = require('fs');
const path = require('path');
const profiles = require('./profiles');
const { fetchJson, download } = require('./net');

const MODRINTH = 'https://api.modrinth.com/v2';

/* Shaderpacks and resource packs live in the game folder next to options.txt.
   Iris/OptiFine read the selected pack from optionsshaders.txt, while vanilla
   reads the enabled packs from the resourcePacks line in options.txt, so both
   setters edit those files instead of keeping a private list only we read. */

function shaderpacksDir(profileId) {
  return path.join(profiles.gameDir(profileId), 'shaderpacks');
}

function resourcepacksDir(profileId) {
  return path.join(profiles.gameDir(profileId), 'resourcepacks');
}

function shaderOptionsFile(profileId) {
  return path.join(profiles.gameDir(profileId), 'optionsshaders.txt');
}

function gameOptionsFile(profileId) {
  return path.join(profiles.gameDir(profileId), 'options.txt');
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    return '';
  }
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, file);
}

function splitLines(text) {
  return text ? text.split(/\r?\n/) : [];
}

function optionValue(lines, key) {
  const prefix = `${key}:`;
  for (const line of lines) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return null;
}

function setOptionLine(lines, key, value) {
  const prefix = `${key}:`;
  const index = lines.findIndex((line) => line.startsWith(prefix));
  if (index === -1) lines.push(`${key}:${value}`);
  else lines[index] = `${key}:${value}`;
}

function parseList(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch (err) {
    return [];
  }
}

function activeShaderName(profileId) {
  const lines = splitLines(readText(shaderOptionsFile(profileId)));
  const value = optionValue(lines, 'shaderPack');
  if (!value || value === 'OFF' || value === '(internal)') return null;
  return value;
}

function setActiveShaderpack(profileId, filename) {
  if (filename) {
    const file = path.join(shaderpacksDir(profileId), filename);
    if (!fs.existsSync(file)) return { success: false, message: 'Shaderpack not found.' };
  }

  const file = shaderOptionsFile(profileId);
  const lines = splitLines(readText(file));

  // Iris and OptiFine both start from the defaults they write on first launch;
  // when the file does not exist yet, only the shader key is needed.
  setOptionLine(lines, 'shaderPack', filename || 'OFF');
  writeText(file, `${lines.join('\n')}\n`);
  return { success: true };
}

function activeResourcepacks(profileId) {
  const lines = splitLines(readText(gameOptionsFile(profileId)));
  const raw = optionValue(lines, 'resourcePacks');
  return parseList(raw).map((entry) => entry.replace(/^file\//, ''));
}

function setActiveResourcepacks(profileId, filenames) {
  const dir = resourcepacksDir(profileId);
  for (const filename of filenames) {
    if (!fs.existsSync(path.join(dir, filename))) {
      return { success: false, message: `${filename} is not in this profile's resourcepacks folder.` };
    }
  }

  const file = gameOptionsFile(profileId);
  const lines = splitLines(readText(file));
  const entries = filenames.map((name) => `file/${name}`);
  setOptionLine(lines, 'resourcePacks', JSON.stringify(entries));
  setOptionLine(lines, 'incompatibleResourcePacks', '[]');
  writeText(file, `${lines.join('\n')}\n`);
  return { success: true };
}

function listShaderpacks(profileId) {
  const dir = shaderpacksDir(profileId);
  fs.mkdirSync(dir, { recursive: true });

  let files = [];
  try { files = fs.readdirSync(dir); } catch (err) { files = []; }

  const active = activeShaderName(profileId);
  const shaderpacks = [];

  for (const file of files) {
    if (!/\.zip$/i.test(file)) continue;
    const full = path.join(dir, file);
    let size = 0;
    try { size = fs.statSync(full).size; } catch (err) { size = 0; }

    shaderpacks.push({
      filename: file,
      name: file.replace(/\.zip$/i, ''),
      size,
      active: file === active
    });
  }

  shaderpacks.sort((a, b) => a.name.localeCompare(b.name));
  return shaderpacks;
}

function listResourcepacks(profileId) {
  const dir = resourcepacksDir(profileId);
  fs.mkdirSync(dir, { recursive: true });

  let files = [];
  try { files = fs.readdirSync(dir); } catch (err) { files = []; }

  const active = new Set(activeResourcepacks(profileId));
  const packs = [];

  for (const file of files) {
    if (!/\.zip$/i.test(file)) continue;
    const full = path.join(dir, file);
    let size = 0;
    try { size = fs.statSync(full).size; } catch (err) { size = 0; }

    packs.push({
      filename: file,
      name: file.replace(/\.zip$/i, ''),
      size,
      active: active.has(file)
    });
  }

  packs.sort((a, b) => a.name.localeCompare(b.name));
  return packs;
}

function safeFileName(name) {
  return typeof name === 'string'
    && name.length > 0
    && name.length < 200
    && !name.includes('..')
    && path.basename(name) === name;
}

function removeShaderpack(profileId, filename) {
  if (!safeFileName(filename)) return { success: false, message: 'Unknown shaderpack.' };
  fs.rmSync(path.join(shaderpacksDir(profileId), filename), { force: true });
  if (activeShaderName(profileId) === filename) setActiveShaderpack(profileId, null);
  return { success: true };
}

function removeResourcepack(profileId, filename) {
  if (!safeFileName(filename)) return { success: false, message: 'Unknown resource pack.' };
  fs.rmSync(path.join(resourcepacksDir(profileId), filename), { force: true });
  const remaining = activeResourcepacks(profileId).filter((name) => name !== filename);
  const dir = resourcepacksDir(profileId);
  const kept = remaining.filter((name) => fs.existsSync(path.join(dir, name)));
  if (kept.length !== remaining.length) setActiveResourcepacks(profileId, kept);
  return { success: true };
}

/* ---------- Modrinth ---------- */

function projectType(type, query, gameVersion, limit) {
  const facets = [['project_type:' + type]];
  if (gameVersion) facets.push([`versions:${gameVersion}`]);

  const params = new URLSearchParams({
    query: query || '',
    limit: String(Math.min(Math.max(Number(limit) || 20, 1), 40)),
    index: query ? 'relevance' : 'downloads',
    facets: JSON.stringify(facets)
  });
  return `${MODRINTH}/search?${params}`;
}

function mapHits(data) {
  return {
    total: data.total_hits || 0,
    hits: (data.hits || []).map((hit) => ({
      id: hit.project_id,
      slug: hit.slug,
      title: hit.title,
      description: hit.description,
      author: hit.author,
      downloads: hit.downloads,
      icon: hit.icon_url
    }))
  };
}

async function searchShaderpacks(query, gameVersion) {
  try {
    const data = await fetchJson(projectType('shader', query, gameVersion));
    return { success: true, ...mapHits(data) };
  } catch (err) {
    return { success: false, message: 'Could not reach Modrinth.' };
  }
}

async function searchResourcepacks(query, gameVersion) {
  try {
    const data = await fetchJson(projectType('resourcepack', query, gameVersion));
    return { success: true, ...mapHits(data) };
  } catch (err) {
    return { success: false, message: 'Could not reach Modrinth.' };
  }
}

async function newestFile(projectId, gameVersion) {
  const params = new URLSearchParams();
  if (gameVersion) params.set('game_versions', JSON.stringify([gameVersion]));

  const versions = await fetchJson(
    `${MODRINTH}/project/${encodeURIComponent(projectId)}/version?${params}`
  );
  const version = Array.isArray(versions) ? versions[0] : null;
  const file = version?.files?.find((entry) => entry.primary) || version?.files?.[0];
  if (!file) throw new Error('No download is published for this version.');
  return file;
}

async function installShaderpackFromModrinth(profileId, projectId, gameVersion) {
  const file = await newestFile(projectId, gameVersion);
  const dir = shaderpacksDir(profileId);
  fs.mkdirSync(dir, { recursive: true });

  const name = safeFileName(file.filename) ? file.filename : `shader-${Date.now()}.zip`;
  await download(file.url, path.join(dir, name));
  return { filename: name, size: file.size || 0 };
}

async function installResourcepackFromModrinth(profileId, projectId, gameVersion) {
  const file = await newestFile(projectId, gameVersion);
  const dir = resourcepacksDir(profileId);
  fs.mkdirSync(dir, { recursive: true });

  const name = safeFileName(file.filename) ? file.filename : `pack-${Date.now()}.zip`;
  await download(file.url, path.join(dir, name));
  return { filename: name, size: file.size || 0 };
}

module.exports = {
  shaderpacksDir,
  resourcepacksDir,
  listShaderpacks,
  listResourcepacks,
  installShaderpackFromModrinth,
  installResourcepackFromModrinth,
  removeShaderpack,
  removeResourcepack,
  setActiveShaderpack,
  setActiveResourcepacks,
  activeShaderName,
  activeResourcepacks,
  searchShaderpacks,
  searchResourcepacks
};