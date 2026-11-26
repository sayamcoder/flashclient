const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { fetchJson, fetchText, download, mapLimit } = require('./net');
const { extractZip } = require('./zip');
const { resolveJava, requiredMajor } = require('./java');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const RESOURCES_URL = 'https://resources.download.minecraft.net';
const LIBRARIES_URL = 'https://libraries.minecraft.net/';
const FABRIC_META = 'https://meta.fabricmc.net/v2';
const FORGE_MAVEN = 'https://maven.minecraftforge.net/';
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/';

const OS_NAME = 'windows';
const OS_ARCH = process.arch === 'x64' ? 'x86_64' : process.arch;
const OS_VERSION = os.release();

/* Instances imported from another launcher point at that .minecraft so the
   versions/libraries/assets already on disk are used instead of re-downloaded.
   Java and installer staging always stay in the launcher's own folder. */
function dataDirs(rootOverride) {
  const owned = path.join(app.getPath('userData'), 'data');
  const game = rootOverride || owned;
  return {
    data: owned,
    game,
    versions: path.join(game, 'versions'),
    libraries: path.join(game, 'libraries'),
    assets: path.join(game, 'assets'),
    runtimes: path.join(owned, 'runtimes'),
    install: path.join(owned, 'install')
  };
}

/* ---------- version manifest ---------- */

let manifestCache = { at: 0, data: null };

/* Mojang being briefly unreachable should not empty the version picker; the
   last good manifest is kept on disk and used when the request fails. */
function manifestFile() {
  return path.join(app.getPath('userData'), 'version-manifest.json');
}

function cachedManifest() {
  try {
    const data = JSON.parse(fs.readFileSync(manifestFile(), 'utf8'));
    return Array.isArray(data?.versions) ? data : null;
  } catch (err) {
    return null;
  }
}

async function versionManifest() {
  if (manifestCache.data && Date.now() - manifestCache.at < 10 * 60 * 1000) return manifestCache.data;
  try {
    const data = await fetchJson(MANIFEST_URL);
    manifestCache = { at: Date.now(), data };
    try { fs.writeFileSync(manifestFile(), JSON.stringify(data)); } catch (err) { /* cache is best-effort */ }
    return data;
  } catch (err) {
    const fallback = cachedManifest();
    if (!fallback) throw err;
    manifestCache = { at: Date.now(), data: fallback };
    return fallback;
  }
}

async function minecraftVersions() {
  const manifest = await versionManifest();
  return manifest.versions
    .filter((v) => v.type === 'release' || v.type === 'snapshot')
    .map((v) => ({ id: v.id, type: v.type, releaseTime: v.releaseTime }));
}

async function vanillaJson(id, rootOverride) {
  const dir = path.join(dataDirs(rootOverride).versions, id);
  const file = path.join(dir, `${id}.json`);
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      // corrupt cache, fetch it again
    }
  }

  const manifest = await versionManifest();
  const entry = manifest.versions.find((v) => v.id === id);
  if (!entry) throw new Error(`Minecraft ${id} is not in Mojang's version list.`);

  const json = await fetchJson(entry.url);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
  return json;
}

/* ---------- library rules ---------- */

function ruleMatches(rule) {
  const features = rule.features;
  if (features) {
    for (const key of Object.keys(features)) {
      // No demo account, custom resolution or quick-play handoff in this launcher.
      if (features[key]) return false;
    }
  }

  const target = rule.os;
  if (!target) return true;
  if (target.name && target.name !== OS_NAME) return false;
  if (target.arch && target.arch !== OS_ARCH) return false;
  if (target.version) {
    try {
      if (!new RegExp(target.version).test(OS_VERSION)) return false;
    } catch (err) {
      return false;
    }
  }
  return true;
}

function rulesAllow(rules) {
  if (!Array.isArray(rules) || !rules.length) return true;
  let allowed = false;
  for (const rule of rules) {
    if (!ruleMatches(rule)) continue;
    allowed = rule.action === 'allow';
  }
  return allowed;
}

function mavenRelPath(name) {
  const [group, artifact, version, classifier] = String(name).split(':');
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`;
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`;
}

function libraryArtifact(lib) {
  if (lib.downloads?.artifact?.url) return lib.downloads.artifact;
  // A Mojang-style entry without "artifact" is classifier-only (the natives
  // jars); there is no plain jar in the maven to fetch.
  if (lib.downloads) return null;
  if (!lib.name) return null;
  const rel = mavenRelPath(lib.name);
  const base = lib.url || LIBRARIES_URL;
  return { path: rel, url: base.replace(/\/?$/, '/') + rel };
}

/* A few old natives entries use Mojo's ${arch} placeholder instead of naming
   the 32/64-bit classifier outright. */
function nativeClassifier(lib) {
  const raw = lib.natives?.windows;
  if (!raw) return null;
  return raw.replace('${arch}', process.arch === 'x64' ? '64' : '32');
}

function nativeArtifact(lib, classifier) {
  if (lib.downloads?.classifiers?.[classifier]) return lib.downloads.classifiers[classifier];
  if (!lib.name) return null;
  const [group, artifact, version] = lib.name.split(':');
  const file = `${artifact}-${version}-${classifier}.jar`;
  const rel = `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`;
  const base = lib.url || LIBRARIES_URL;
  return { path: rel, url: base.replace(/\/?$/, '/') + rel };
}

/* ---------- progress ---------- */

function progressReporter(onProgress, weights) {
  let current = weights[0]?.from ?? 0;
  let phaseStart = current;
  let phaseEnd = weights[0]?.to ?? 1;

  return (patch) => {
    if (!onProgress) return;
    if (patch.phase && weights.some((w) => w.phase === patch.phase)) {
      const band = weights.find((w) => w.phase === patch.phase);
      current = band.from;
      phaseStart = band.from;
      phaseEnd = band.to;
    }
    const inner = Number.isFinite(patch.ratio) ? Math.min(Math.max(patch.ratio, 0), 1) : 0;
    current = phaseStart + (phaseEnd - phaseStart) * inner;
    onProgress({ ...patch, overall: current });
  };
}

/* ---------- files ---------- */

function collectLibraries(json) {
  const keep = [];
  const natives = [];

  for (const lib of json.libraries || []) {
    if (!rulesAllow(lib.rules)) continue;

    const artifact = libraryArtifact(lib);
    if (artifact) keep.push(artifact);

    const classifier = nativeClassifier(lib);
    if (classifier) {
      const native = nativeArtifact(lib, classifier);
      if (native) natives.push({ artifact: native, exclude: lib.extract?.exclude || [] });
    }
  }

  return { keep, natives };
}

/* Fabric ships its own ASM while Mojang's version json ships another, and two
   copies of the same classes on one classpath make the loader refuse to start.
   Identity ignores the version. The first list passed in wins, and callers put
   the loader's libraries first because those are the ones it expects. */
function artifactKey(lib) {
  const name = lib?.name;
  if (typeof name === 'string') {
    const [group, artifact, , classifier] = name.split(':');
    if (group && artifact) return `${group}:${artifact}:${classifier || ''}`;
  }
  return lib?.downloads?.artifact?.path || JSON.stringify(lib);
}

function mergeUnique(base, extra) {
  const seen = new Set();
  const out = [];
  for (const lib of [...base, ...extra]) {
    const key = artifactKey(lib);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(lib);
  }
  return out;
}

async function copyTree(from, to) {
  if (!fs.existsSync(from)) return;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(target, { recursive: true });
      await copyTree(source, target);
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
  }
}

function parseVersions(xml) {
  return [...String(xml).matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
}

function versionKey(version) {
  return String(version).split(/[^0-9]+/).filter(Boolean).map(Number);
}

function compareVersions(a, b) {
  const left = versionKey(a);
  const right = versionKey(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function mergeLoader(base, loaderJson) {
  return {
    ...base,
    ...loaderJson,
    id: loaderJson.id,
    inheritsFrom: base.id,
    libraries: mergeUnique(loaderJson.libraries || [], base.libraries || []),
    mainClass: loaderJson.mainClass || base.mainClass,
    minecraftArguments: loaderJson.minecraftArguments || base.minecraftArguments,
    arguments: {
      game: [...(base.arguments?.game || []), ...(loaderJson.arguments?.game || [])],
      jvm: [...(base.arguments?.jvm || []), ...(loaderJson.arguments?.jvm || [])]
    },
    assetIndex: base.assetIndex,
    assets: base.assets,
    downloads: base.downloads,
    javaVersion: base.javaVersion
  };
}

/* ---------- loaders ---------- */

async function ensureFabric(profile, base, dirs, onProgress, minLoader) {
  const gameVersion = profile.gameVersion;
  const loaders = await fetchJson(`${FABRIC_META}/versions/loader/${encodeURIComponent(gameVersion)}`);
  const entry = loaders.find((l) => l.loader?.stable) || loaders[0];
  if (!entry?.loader?.version) throw new Error(`Fabric has no loader build for ${gameVersion}.`);
  if (minLoader && !atLeast(entry.loader.version, minLoader)) {
    throw new Error(`This profile's mods need Fabric ${minLoader} or newer, but only ${entry.loader.version} is published for ${gameVersion}.`);
  }

  onProgress?.({ phase: 'loader', message: `Fabric ${entry.loader.version}`, done: 1, total: 1, ratio: 1 });
  const meta = await fetchJson(
    `${FABRIC_META}/versions/loader/${encodeURIComponent(gameVersion)}/${entry.loader.version}/profile/json`
  );

  // Keep the profile on disk so the next launch reuses it and works offline.
  const dir = path.join(dirs.versions, meta.id);
  const file = path.join(dir, `${meta.id}.json`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(meta, null, 2));
  }

  return {
    id: meta.id,
    label: `Fabric ${entry.loader.version}`,
    json: mergeLoader(base, meta)
  };
}

async function ensureForge(profile, base, dirs, onProgress) {
  const gameVersion = profile.gameVersion;
  const versions = parseVersions(await fetchText(`${FORGE_MAVEN}net/minecraftforge/forge/maven-metadata.xml`));
  const wanted = versions
    .filter((v) => v.startsWith(`${gameVersion}-`))
    .sort(compareVersions)
    .pop();

  if (!wanted) throw new Error(`Forge has no build for ${gameVersion}.`);

  const loaderDir = path.join(dirs.install, `forge-${wanted}`);
  const installer = path.join(loaderDir, 'installer.jar');
  const profileJson = path.join(loaderDir, 'install_profile.json');

  onProgress?.({ phase: 'loader', message: `Installing Forge ${wanted.split('-')[1]}`, done: 0, total: 1, ratio: 0 });
  if (!fs.existsSync(installer)) {
    await download(`${FORGE_MAVEN}net/minecraftforge/forge/${wanted}/forge-${wanted}-installer.jar`, installer);
  }

  if (!fs.existsSync(profileJson)) {
    extractZip(installer, loaderDir, { filter: (name) => name === 'install_profile.json' });
  }

  const install = JSON.parse(fs.readFileSync(profileJson, 'utf8'));
  const info = install.versionInfo;
  if (!info) throw new Error('That Forge installer does not contain a client profile.');

  // The installer records the universal jar's own name in filePath; older
  // installers only have "universal". Either way it sits at the archive root
  // and still has to be copied into the maven layout under the plain name.
  const universalName = install.install?.filePath || install.filePath || install.universal || `forge-${wanted}-universal.jar`;
  const stableName = `forge-${wanted}.jar`;
  const target = path.join(dirs.libraries, 'net', 'minecraftforge', 'forge', wanted, stableName);

  if (!fs.existsSync(target)) {
    const extracted = path.join(loaderDir, 'universal');
    extractZip(installer, extracted, { filter: (name) => name === universalName });
    const source = path.join(extracted, universalName);
    if (!fs.existsSync(source)) {
      throw new Error(`That Forge installer does not contain ${universalName}.`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    fs.rmSync(extracted, { recursive: true, force: true });
  }

  onProgress?.({ phase: 'loader', message: `Forge ${wanted.split('-')[1]}`, done: 1, total: 1, ratio: 1 });
  return {
    id: info.id || `${gameVersion}-forge${wanted}`,
    label: `Forge ${wanted.split('-')[1]}`,
    json: mergeLoader(base, info)
  };
}

/* Windows refuses to start a broken runtime with "spawn UNKNOWN", which says
   nothing. Loader installers run on the same java.exe, so they get the same
   plain-language explanation as the game launch. */
function javaStartError(err, javaPath) {
  const code = String(err?.code || '').toUpperCase();
  if (code === 'ENOENT') return new Error(`Java is missing at ${javaPath}. Let the launcher install it again.`);
  if (code === 'EACCES') return new Error(`Windows blocked ${javaPath} from starting. Check antivirus and retry.`);
  if (code === 'UNKNOWN' || code === 'EINVAL') {
    return new Error(`${javaPath} could not be started by Windows. That Java runtime looks broken — install it again and retry.`);
  }
  return err;
}

function runInstaller(javaPath, installer, targetDir, onProgress, label) {
  return new Promise((resolve, reject) => {
    onProgress?.({ phase: 'loader', message: label, done: 0, total: 1, ratio: 0.05 });

    fs.mkdirSync(targetDir, { recursive: true });

    let child;
    try {
      child = spawn(javaPath, ['-jar', installer, '--installClient', targetDir], {
        cwd: targetDir,
        windowsHide: true
      });
    } catch (err) {
      reject(javaStartError(err, javaPath));
      return;
    }

    let tail = '';
    const collect = (chunk) => {
      tail = (tail + chunk.toString()).slice(-2000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    child.on('error', (err) => reject(javaStartError(err, javaPath)));
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed.\n${tail.split('\n').slice(-4).join('\n')}`));
    });
  });
}

async function ensureNeoForge(profile, base, dirs, java, clientJar, onProgress) {
  const gameVersion = profile.gameVersion;
  const [major, minor] = gameVersion.split('.');
  const prefix = `${major}.${minor}.`;

  const versions = parseVersions(await fetchText(`${NEOFORGE_MAVEN}net/neoforged/neoforge/maven-metadata.xml`));
  const wanted = versions.filter((v) => v.startsWith(prefix)).sort(compareVersions).pop();
  if (!wanted) throw new Error(`NeoForge has no build for ${gameVersion}.`);

  const loaderId = `neoforge-${wanted}`;
  const versionDir = path.join(dirs.versions, loaderId);
  const jsonFile = path.join(versionDir, `${loaderId}.json`);

  if (!fs.existsSync(jsonFile)) {
    const stage = path.join(dirs.install, loaderId);
    const vanillaDir = path.join(stage, 'versions', base.id);
    fs.mkdirSync(vanillaDir, { recursive: true });
    fs.copyFileSync(path.join(dirs.versions, base.id, `${base.id}.json`), path.join(vanillaDir, `${base.id}.json`));
    fs.copyFileSync(clientJar, path.join(vanillaDir, `${base.id}.jar`));
    fs.writeFileSync(path.join(stage, 'launcher_profiles.json'), JSON.stringify({ profiles: {}, settings: {}, version: 3 }));

    const installer = path.join(dirs.install, `${loaderId}-installer.jar`);
    if (!fs.existsSync(installer)) {
      onProgress?.({ phase: 'loader', message: `Downloading NeoForge ${wanted}`, done: 0, total: 1, ratio: 0 });
      await download(`${NEOFORGE_MAVEN}net/neoforged/neoforge/${wanted}/neoforge-${wanted}-installer.jar`, installer);
    }

    await runInstaller(java.path, installer, stage, onProgress, `Installing NeoForge ${wanted}`);

    const produced = path.join(stage, 'versions', loaderId);
    if (!fs.existsSync(path.join(produced, `${loaderId}.json`))) {
      throw new Error('NeoForge finished but did not write a launch profile.');
    }

    fs.mkdirSync(versionDir, { recursive: true });
    fs.copyFileSync(path.join(produced, `${loaderId}.json`), jsonFile);
    await copyTree(path.join(stage, 'libraries'), dirs.libraries);
    fs.rmSync(stage, { recursive: true, force: true });
  }

  const loaderJson = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  onProgress?.({ phase: 'loader', message: `NeoForge ${wanted}`, done: 1, total: 1, ratio: 1 });

  return { id: loaderId, label: `NeoForge ${wanted}`, json: mergeLoader(base, loaderJson) };
}

/* ---------- files ---------- */

async function ensureClientJar(base, dirs, onProgress) {
  const dir = path.join(dirs.versions, base.id);
  const jar = path.join(dir, `${base.id}.jar`);
  const client = base.downloads?.client;
  if (!client) throw new Error(`Mojang has no client download for ${base.id}.`);

  onProgress?.({ phase: 'client', message: `Minecraft ${base.id}`, done: 0, total: 1, ratio: 0 });
  await download(client.url, jar, {
    expectedSize: client.size,
    sha1: client.sha1,
    onBytes: (chunk) => {
      const size = client.size || 0;
      const bytes = (ensureClientJar.bytes = (ensureClientJar.bytes || 0) + chunk);
      onProgress?.({
        phase: 'client',
        message: `Minecraft ${base.id}`,
        bytes,
        ratio: size ? Math.min(1, bytes / size) : 0.5
      });
    }
  });
  ensureClientJar.bytes = 0;
  onProgress?.({ phase: 'client', message: `Minecraft ${base.id}`, bytes: client.size, ratio: 1 });
  return jar;
}

async function ensureLibraryTree(json, dirs, nativesDir, onProgress) {
  const { keep, natives } = collectLibraries(json);
  let done = 0;
  const total = keep.length + natives.length;

  const tick = (label) => {
    done += 1;
    onProgress?.({ phase: 'libraries', message: label, done, total, ratio: total ? done / total : 1 });
  };

  await mapLimit(keep, 6, async (artifact) => {
    const rel = artifact.path;
    const dest = path.join(dirs.libraries, rel);
    await download(artifact.url, dest, { expectedSize: artifact.size, sha1: artifact.sha1 });
    tick(rel.split('/').pop());
  });

  await mapLimit(natives, 4, async ({ artifact, exclude }) => {
    const jarPath = path.join(dirs.install, 'natives', artifact.path);
    await download(artifact.url, jarPath, { expectedSize: artifact.size, sha1: artifact.sha1 });

    const allowed = (name) => {
      if (!name || name.endsWith('/')) return false;
      if (name.startsWith('META-INF/')) return false;
      return !exclude.some((prefix) => name.startsWith(prefix));
    };
    extractZip(jarPath, nativesDir, { filter: allowed });
    tick(artifact.path.split('/').pop());
  });

  return keep.map((artifact) => path.join(dirs.libraries, artifact.path));
}

async function ensureAssets(json, dirs, onProgress) {
  const index = json.assetIndex;
  if (!index) return { indexId: 'legacy', total: 0 };

  const indexPath = path.join(dirs.assets, 'indexes', `${index.id}.json`);
  await download(index.url, indexPath, { expectedSize: index.size, sha1: index.sha1 });

  const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  // Identical files share a hash, so a plain Object.values() would queue the
  // same object several times and download it in parallel.
  const objects = [...new Map(Object.values(parsed.objects || {}).map((object) => [object.hash, object])).values()];
  let done = 0;

  await mapLimit(objects, 10, async (object) => {
    const prefix = object.hash.slice(0, 2);
    const dest = path.join(dirs.assets, 'objects', prefix, object.hash);
    await download(`${RESOURCES_URL}/${prefix}/${object.hash}`, dest, { expectedSize: object.size });
    done += 1;
    if (done % 4 === 0 || done === objects.length) {
      onProgress?.({
        phase: 'assets',
        message: `${done} of ${objects.length} assets`,
        done,
        total: objects.length,
        ratio: objects.length ? done / objects.length : 1
      });
    }
  });

  return { indexId: index.id, total: objects.length };
}

/* ---------- entry points ---------- */

/* An imported install usually already has its loader version on disk. Reading
   that profile means no installer download and the same build the player used. */
function findInstalledLoader(profile, dirs, base, minFabricLoader) {
  if (!['fabric', 'forge', 'neoforge'].includes(profile.loader)) return null;

  let names = [];
  try {
    names = fs.readdirSync(dirs.versions, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (err) {
    return null;
  }

  const matches = [];
  for (const name of names) {
    const json = jsonSafe(path.join(dirs.versions, name, `${name}.json`));
    if (!json) continue;

    const id = String(json.id || name);
    const parent = String(json.inheritsFrom || '');
    let ok = false;

    if (profile.loader === 'fabric') {
      ok = /^fabric-loader-/i.test(id) && (parent === base.id || id.endsWith(base.id));
    } else if (profile.loader === 'neoforge') {
      ok = /^neoforge-/i.test(id) && (!parent || parent === base.id);
    } else {
      ok = /forge/i.test(id) && (parent === base.id || id.startsWith(`${base.id}-forge`));
    }
    if (ok) matches.push({ id, json, loaderVersion: loaderVersionOf(id) });
  }

  // A mod can demand a newer loader than the one already on disk; using the
  // old build would only fail inside the game with an incompatible-mods screen.
  let usable = matches;
  if (profile.loader === 'fabric' && minFabricLoader) {
    usable = matches
      .filter((m) => atLeast(m.loaderVersion, minFabricLoader))
      .sort((a, b) => (atLeast(a.loaderVersion, b.loaderVersion) ? -1 : 1));
  }

  if (!usable.length) return null;
  const pinned = profile.loaderVersion && usable.find((m) => m.id.includes(profile.loaderVersion));
  const chosen = pinned || usable[0];
  const usedVersion = chosen.loaderVersion || profile.loaderVersion;
  return {
    id: chosen.id,
    label: `${profile.loader === 'neoforge' ? 'NeoForge' : profile.loader === 'fabric' ? 'Fabric' : 'Forge'} ${usedVersion || ''}`.trim(),
    json: mergeLoader(base, chosen.json)
  };
}

function jsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

function loaderVersionOf(id) {
  const match = String(id).match(/^fabric-loader-([\d.]+)-/i);
  return match ? match[1] : '';
}

function atLeast(version, floor) {
  const left = String(version).split(/[^0-9]+/).filter(Boolean).map(Number);
  const right = String(floor).split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff > 0;
  }
  return true;
}

async function prepareProfile(profile, settings, onProgress, opts = {}) {
  const dirs = dataDirs(profile.runtimeDir || profile.minecraftDir);
  const report = progressReporter(onProgress, [
    { phase: 'java', from: 0, to: 0.12 },
    { phase: 'loader', from: 0.12, to: 0.2 },
    { phase: 'client', from: 0.2, to: 0.26 },
    { phase: 'libraries', from: 0.26, to: 0.42 },
    { phase: 'assets', from: 0.42, to: 0.98 }
  ]);

  const base = await vanillaJson(profile.gameVersion, dirs.game);
  const javaMajor = requiredMajor(base, profile.gameVersion);
  const java = await resolveJava({
    dataDir: dirs.data,
    configured: profile.javaPath || settings.javaPath,
    major: javaMajor,
    autoInstall: settings.autoInstallJava,
    onProgress: report
  });

  const clientJar = await ensureClientJar(base, dirs, report);

  let version = findInstalledLoader(profile, dirs, base, opts.minFabricLoader);
  if (version) {
    report({ phase: 'loader', message: `Using installed ${version.label}`, done: 1, total: 1, ratio: 1 });
  } else if (profile.loader === 'fabric') version = await ensureFabric(profile, base, dirs, report, opts.minFabricLoader);
  else if (profile.loader === 'forge') version = await ensureForge(profile, base, dirs, report);
  else if (profile.loader === 'neoforge') version = await ensureNeoForge(profile, base, dirs, java, clientJar, report);
  else version = { id: base.id, label: 'Vanilla', json: base };

  const nativesDir = path.join(dirs.install, 'natives', base.id);
  fs.mkdirSync(nativesDir, { recursive: true });

  const classpath = await ensureLibraryTree(version.json, dirs, nativesDir, report);
  const assets = await ensureAssets(version.json, dirs, report);

  report({ phase: 'done', message: 'Ready', ratio: 1, done: 1, total: 1 });

  return {
    java,
    versionId: version.id,
    versionLabel: version.label,
    json: version.json,
    baseId: base.id,
    clientJar,
    classpath,
    nativesDir,
    librariesDir: dirs.libraries,
    assetsDir: dirs.assets,
    assetIndex: assets.indexId
  };
}

module.exports = {
  dataDirs,
  minecraftVersions,
  vanillaJson,
  prepareProfile,
  ensureClientJar,
  requiredMajor,
  rulesAllow
};
