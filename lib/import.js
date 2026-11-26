const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function defaultRoot() {
  return path.join(app.getPath('appData'), '.minecraft');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

/* Works out what a versions/<id> folder actually is from its id and json.
   Unknown ids (OptiFine builds and the like) are reported unsupported so the
   importer does not offer something it cannot launch. */
function describeVersion(id, json, versionsDir) {
  const parent = typeof json?.inheritsFrom === 'string' ? json.inheritsFrom : '';
  const base = /^\d+\.\d+(?:\.\d+)?$/.test(id) ? id : '';

  let loader = 'vanilla';
  let loaderVersion = '';
  let gameVersion = parent || base;

  const fabric = id.match(/^fabric-loader-([\d.]+)-(.+)$/i);
  const forge = id.match(/^(.+?)-forge-?(.+)$/i);
  const neoforge = id.match(/^(?:(\d+\.\d+(?:\.\d+)?)-)?neoforge-?(.+)$/i);

  if (fabric) {
    loader = 'fabric';
    loaderVersion = fabric[1];
    gameVersion = parent || fabric[2];
  } else if (neoforge) {
    loader = 'neoforge';
    loaderVersion = neoforge[2];
    gameVersion = parent || neoforge[1] || '';
  } else if (forge) {
    loader = 'forge';
    loaderVersion = forge[2];
    gameVersion = parent || forge[1];
  }

  const hasJar = (name) => name
    ? fs.existsSync(path.join(versionsDir, name, `${name}.jar`))
    : false;

  return {
    loader,
    loaderVersion,
    gameVersion,
    supported: loader !== 'vanilla' || Boolean(base),
    jar: hasJar(id) || hasJar(parent),
    type: json?.type || 'release'
  };
}

/* A launchable install needs both the version json and the asset index; a
   half-copied .minecraft (json but no assets) is not usable on its own. */
function isInstall(root) {
  try {
    if (!fs.statSync(path.join(root, 'assets', 'indexes')).isDirectory()) return false;
  } catch (err) {
    return false;
  }
  try {
    return fs.readdirSync(path.join(root, 'versions'), { withFileTypes: true })
      .some((entry) => entry.isDirectory()
        && fs.existsSync(path.join(root, 'versions', entry.name, `${entry.name}.json`)));
  } catch (err) {
    return false;
  }
}

function isGameFolder(root) {
  return ['options.txt', 'mods', 'saves', 'config', 'resourcepacks']
    .some((name) => fs.existsSync(path.join(root, name)));
}

/* Launchers like Lunar and FastClient keep one shared runtime and put each
   instance's mods/saves in its own folder, so the picked folder is often the
   game folder rather than the install. Look next to it and in the usual
   launcher data folders for the files that actually launch it. */
function runtimeCandidates(root) {
  const roaming = process.env.APPDATA || '';
  const parent = path.dirname(root);
  const names = ['.minecraft', '.fastclient'];
  const out = [root];

  for (const name of names) {
    out.push(path.join(root, name), path.join(parent, name));
  }
  for (const name of names) out.push(path.join(roaming, name));
  out.push(path.join(roaming, '.lunarclient', 'offline', 'multiver'));

  return [...new Set(out.map((dir) => path.normalize(dir)))];
}

function findRuntime(root) {
  return runtimeCandidates(root).find((dir) => isInstall(dir)) || null;
}

/* "1.21.11-Fabric" should preselect the Fabric build of 1.21.11, not vanilla,
   so the folder's mods keep working. */
function matchFolderName(root, versions) {
  const match = path.basename(root).match(/\d+\.\d+(?:\.\d+)?/);
  if (!match) return null;

  const game = match[0];
  const hits = versions.filter((v) => v.supported
    && (v.id === game || v.gameVersion === game || v.id.endsWith(`-${game}`)));
  if (!hits.length) return null;

  const name = path.basename(root);
  const prefer = hits.filter((v) => {
    if (/fabric/i.test(name)) return v.loader === 'fabric';
    if (/forge/i.test(name)) return v.loader === 'forge' || v.loader === 'neoforge';
    return v.loader !== 'vanilla';
  });
  return new Set((prefer.length ? prefer : hits).map((v) => v.id));
}

function listVersions(installRoot) {
  const versionsDir = path.join(installRoot, 'versions');
  const versions = [];

  for (const entry of fs.readdirSync(versionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const json = readJson(path.join(versionsDir, entry.name, `${entry.name}.json`));
    if (!json) continue;
    versions.push({ id: entry.name, ...describeVersion(entry.name, json, versionsDir) });
  }

  versions.sort((a, b) => String(b.gameVersion).localeCompare(String(a.gameVersion), undefined, { numeric: true })
    || a.id.localeCompare(b.id));
  return versions;
}

function scan(root = defaultRoot()) {
  const nested = path.join(root, '.minecraft');
  const install = isInstall(root) ? root : isInstall(nested) ? nested : null;

  if (install) {
    return { success: true, mode: 'install', root: install, game: install, runtime: install, versions: listVersions(install) };
  }

  if (!isGameFolder(root)) {
    return { success: false, message: `No Minecraft folder at ${root}.`, root, versions: [] };
  }

  const runtime = findRuntime(root);
  if (!runtime) {
    return {
      success: false,
      mode: 'game',
      root,
      versions: [],
      message: 'That is a game folder: it has mods and saves but no version files. Pick the folder that holds versions and assets, usually %APPDATA%\\.minecraft.'
    };
  }

  const versions = listVersions(runtime);
  const suggested = matchFolderName(root, versions);
  return {
    success: true,
    mode: 'game',
    root,
    game: root,
    runtime,
    versions: versions.map((version) => ({ ...version, suggested: suggested ? suggested.has(version.id) : true }))
  };
}

module.exports = { defaultRoot, scan, describeVersion };
