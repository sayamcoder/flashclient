const fs = require('fs');
const path = require('path');
const profiles = require('./profiles');

const API = 'https://api.modrinth.com/v2';
const USER_AGENT = 'FlashClient/1.0.4 (Minecraft launcher)';

function request(pathname) {
  return fetch(`${API}${pathname}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }
  }).then((res) => {
    if (!res.ok) throw new Error(res.status === 404 ? 'Not on Modrinth for this version.' : `Modrinth responded ${res.status}`);
    return res.json();
  });
}

function indexFile(profileId) {
  return path.join(profiles.instanceDir(profileId), 'mods.json');
}

function readIndex(profileId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexFile(profileId), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function writeIndex(profileId, entries) {
  fs.mkdirSync(path.dirname(indexFile(profileId)), { recursive: true });
  fs.writeFileSync(indexFile(profileId), JSON.stringify(entries, null, 2));
}

function safeFileName(name) {
  return typeof name === 'string' && name.length > 0 && !name.includes('..') && path.basename(name) === name;
}

function list(profileId) {
  const dir = profiles.modsDir(profileId);
  const known = new Map(readIndex(profileId).map((entry) => [entry.filename, entry]));
  const installed = [];

  let files = [];
  try { files = fs.readdirSync(dir); } catch (err) { files = []; }

  for (const file of files) {
    const match = file.match(/^(.+\.jar)(\.disabled)?$/i);
    if (!match) continue;

    const filename = match[1];
    const enabled = !match[2];
    const entry = known.get(filename) || {
      filename,
      projectId: null,
      title: filename.replace(/\.jar$/i, ''),
      versionNumber: '',
      icon: null
    };
    known.delete(filename);

    let size = 0;
    try { size = fs.statSync(path.join(dir, file)).size; } catch (err) { size = 0; }
    installed.push({ ...entry, enabled, size });
  }

  installed.sort((a, b) => a.title.localeCompare(b.title));
  writeIndex(profileId, installed.map(({ enabled, size, ...rest }) => rest));
  return installed;
}

async function install(profileId, { projectId, slug, gameVersion, loader, title, icon }) {
  const id = projectId || slug;
  if (!id || !gameVersion || !loader) throw new Error('Missing install details.');

  const versions = await request(
    `/project/${encodeURIComponent(id)}/version?loaders=${encodeURIComponent(JSON.stringify([loader]))}&game_versions=${encodeURIComponent(JSON.stringify([gameVersion]))}`
  );

  const version = Array.isArray(versions) ? versions[0] : null;
  const file = version?.files?.find((f) => f.primary) || version?.files?.[0];
  if (!file) throw new Error(`No ${loader} build for ${gameVersion}.`);

  const dir = profiles.modsDir(profileId);
  fs.mkdirSync(dir, { recursive: true });

  const kept = readIndex(profileId).filter((entry) => {
    if (!projectId || entry.projectId !== projectId) return true;
    fs.rmSync(path.join(dir, entry.filename), { force: true });
    fs.rmSync(path.join(dir, `${entry.filename}.disabled`), { force: true });
    return false;
  });

  const res = await fetch(file.url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error('Download failed.');

  const bytes = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(path.join(dir, file.filename), bytes);

  const entry = {
    filename: file.filename,
    projectId: projectId || null,
    title: title || version.name || file.filename.replace(/\.jar$/i, ''),
    versionNumber: version.version_number || '',
    icon: icon || null,
    installedAt: Date.now()
  };

  writeIndex(profileId, [entry, ...kept]);
  return { ...entry, enabled: true, size: bytes.length };
}

function setEnabled(profileId, filename, enabled) {
  if (!safeFileName(filename)) return { success: false, message: 'Unknown mod.' };
  const dir = profiles.modsDir(profileId);
  const active = path.join(dir, filename);
  const disabled = path.join(dir, `${filename}.disabled`);
  fs.mkdirSync(dir, { recursive: true });

  try {
    if (enabled && fs.existsSync(disabled)) fs.renameSync(disabled, active);
    else if (!enabled && fs.existsSync(active)) fs.renameSync(active, disabled);
    else return { success: false, message: 'That file is not in this profile.' };
  } catch (err) {
    return { success: false, message: err.message };
  }
  return { success: true };
}

function remove(profileId, filename) {
  if (!safeFileName(filename)) return { success: false, message: 'Unknown mod.' };
  const dir = profiles.modsDir(profileId);
  fs.rmSync(path.join(dir, filename), { force: true });
  fs.rmSync(path.join(dir, `${filename}.disabled`), { force: true });
  writeIndex(profileId, readIndex(profileId).filter((entry) => entry.filename !== filename));
  return { success: true };
}

async function projectMeta(slug) {
  try {
    const project = await request(`/project/${encodeURIComponent(slug)}`);
    return { id: project.id, title: project.title, icon: project.icon_url };
  } catch (err) {
    return { id: null, title: slug, icon: null };
  }
}

module.exports = { request, list, install, setEnabled, remove, safeFileName, projectMeta };
