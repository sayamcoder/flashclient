const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const LOADERS = ['vanilla', 'fabric', 'forge', 'neoforge'];

// The three environments the launcher ships knowing about. Their ids match the
// instance folders used before profiles existed, so nothing has to move.
const DEFAULT_PROFILES = [
  { id: '1.8.9', name: '1.8.9 PvP', gameVersion: '1.8.9', loader: 'forge', ram: 4 },
  { id: '1.20.4', name: '1.20.4 SMP', gameVersion: '1.20.4', loader: 'fabric', ram: 4 },
  { id: '1.21.1', name: '1.21.1 Latest', gameVersion: '1.21.1', loader: 'neoforge', ram: 6 }
];

let cache = null;

function storeFile() {
  return path.join(app.getPath('userData'), 'profiles.json');
}

function instanceDir(profileId) {
  return path.join(app.getPath('userData'), 'instances', profileId);
}

// The instance folder is the game directory for profiles the launcher owns.
// Imported profiles keep using the .minecraft they came from, so their
// worlds, options and mods folder carry over untouched.
function gameDir(profileId) {
  const profile = read().profiles.find((p) => p.id === profileId);
  return profile?.minecraftDir || instanceDir(profileId);
}

/* Where versions/libraries/assets live. Instances imported from a launcher
   that keeps one shared runtime store the two apart: the game folder holds
   mods and saves, the runtime holds the launchable files. */
function runtimeDir(profileId) {
  const profile = read().profiles.find((p) => p.id === profileId);
  return profile?.runtimeDir || profile?.minecraftDir || instanceDir(profileId);
}

function modsDir(profileId) {
  return path.join(gameDir(profileId), 'mods');
}

function read() {
  if (cache) return cache;

  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
  } catch (err) {
    saved = null;
  }

  if (!saved || !Array.isArray(saved.profiles) || !saved.profiles.length) {
    saved = {
      profiles: DEFAULT_PROFILES.map((p) => ({ ...p, javaPath: '', createdAt: Date.now() })),
      activeId: DEFAULT_PROFILES[0].id
    };
    write(saved);
  }

  cache = saved;
  if (!cache.profiles.some((p) => p.id === cache.activeId)) {
    cache.activeId = cache.profiles[0].id;
  }
  return cache;
}

function write(data) {
  cache = data;
  fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
  fs.writeFileSync(storeFile(), JSON.stringify(data, null, 2));
}

function cleanProfile(patch) {
  const out = {};
  if (typeof patch.name === 'string' && patch.name.trim()) out.name = patch.name.trim().slice(0, 40);
  if (typeof patch.gameVersion === 'string' && /^[0-9][0-9a-zA-Z._-]*$/.test(patch.gameVersion)) {
    out.gameVersion = patch.gameVersion;
  }
  if (LOADERS.includes(patch.loader)) out.loader = patch.loader;
  if (patch.ram !== undefined) {
    const ram = Number(patch.ram);
    if (Number.isFinite(ram)) out.ram = Math.min(Math.max(Math.round(ram), 1), 32);
  }
  if (typeof patch.javaPath === 'string') out.javaPath = patch.javaPath;
  if (typeof patch.loaderVersion === 'string' && patch.loaderVersion) {
    out.loaderVersion = patch.loaderVersion.slice(0, 40);
  }
  return out;
}

function list() {
  return read().profiles;
}

function active() {
  const data = read();
  return data.profiles.find((p) => p.id === data.activeId) || data.profiles[0];
}

function setActive(id) {
  const data = read();
  if (!data.profiles.some((p) => p.id === id)) return active();
  data.activeId = id;
  write(data);
  return active();
}

function create(patch) {
  const data = read();
  const fields = cleanProfile(patch);
  const base = data.profiles.find((p) => p.gameVersion === fields.gameVersion) || data.profiles[0];

  const profile = {
    id: `p${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
    name: fields.name || `${fields.gameVersion || base.gameVersion} copy`,
    gameVersion: fields.gameVersion || base.gameVersion,
    loader: fields.loader || base.loader,
    ram: fields.ram || base.ram || 4,
    javaPath: fields.javaPath || '',
    createdAt: Date.now()
  };

  // Imported profiles keep using the game folder that already has the files.
  if (typeof patch.minecraftDir === 'string' && fs.existsSync(patch.minecraftDir)) {
    profile.minecraftDir = patch.minecraftDir;
  }
  if (typeof patch.runtimeDir === 'string' && fs.existsSync(patch.runtimeDir)) {
    profile.runtimeDir = patch.runtimeDir;
  }
  if (typeof patch.sourceVersion === 'string' && patch.sourceVersion) {
    profile.sourceVersion = patch.sourceVersion;
  }
  if (typeof patch.loaderVersion === 'string' && patch.loaderVersion) {
    profile.loaderVersion = patch.loaderVersion;
  }

  data.profiles.push(profile);
  write(data);
  return profile;
}

function update(id, patch) {
  const data = read();
  const profile = data.profiles.find((p) => p.id === id);
  if (!profile) return null;

  Object.assign(profile, cleanProfile(patch || {}));
  write(data);
  return profile;
}

// Removing a profile leaves its folder on disk; the files are worth more than
// the row, and the user can still see them in Explorer.
function remove(id) {
  const data = read();
  if (data.profiles.length <= 1) return { success: false, message: 'Keep at least one profile.' };
  if (!data.profiles.some((p) => p.id === id)) return { success: false, message: 'Unknown profile.' };

  data.profiles = data.profiles.filter((p) => p.id !== id);
  if (data.activeId === id) data.activeId = data.profiles[0].id;
  write(data);
  return { success: true, active: active() };
}

module.exports = {
  instanceDir,
  modsDir,
  gameDir,
  runtimeDir,
  list,
  active,
  setActive,
  create,
  update,
  remove
};
