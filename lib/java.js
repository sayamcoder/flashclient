const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { download, fetchText } = require('./net');
const { extractZip } = require('./zip');

function majorOf(version) {
  const match = String(version || '').trim().match(/^(\d+)(?:\.(\d+))?/);
  if (!match) return 0;
  const first = Number(match[1]);
  if (first === 1 && match[2] !== undefined) return Number(match[2]);
  return first;
}

/* Windows 11 ships app-execution aliases (Store stubs, 0-byte links under
   WindowsApps) that answer to `java.exe` but cannot be started. Checking the
   file up front keeps them out of the list instead of killing the scan. */
function isRunnableFile(exe) {
  try {
    const stat = fs.statSync(exe);
    return stat.isFile() && stat.size > 0;
  } catch (err) {
    return false;
  }
}

function probe(exe) {
  return new Promise((resolve) => {
    if (!isRunnableFile(exe)) return resolve(null);
    try {
      // Windows 11 can take a while to launch a freshly installed exe the first
      // time (Defender scan), so give the probe generous headroom.
      execFile(exe, ['-version'], { timeout: 20000, windowsHide: true }, (err, stdout, stderr) => {
        const text = `${stderr || ''}\n${stdout || ''}`;
        const match = text.match(/version "([^"]+)"/);
        if (!match) return resolve(null);
        resolve({ path: exe, version: match[1], major: majorOf(match[1]) });
      });
    } catch (err) {
      resolve(null);
    }
  });
}

function listDirs(parent) {
  try {
    return fs.readdirSync(parent).map((name) => path.join(parent, name));
  } catch (err) {
    return [];
  }
}

function runtimeCandidates(runtimesDir) {
  const found = [];
  for (const root of listDirs(runtimesDir)) {
    const direct = path.join(root, 'bin', 'java.exe');
    if (fs.existsSync(direct)) {
      found.push(direct);
      continue;
    }
    for (const inner of listDirs(root)) {
      const exe = path.join(inner, 'bin', 'java.exe');
      if (fs.existsSync(exe)) found.push(exe);
    }
  }
  return found;
}

function staticCandidates(dataDir, configured) {
  const found = new Set();
  const add = (exe) => {
    if (exe && fs.existsSync(exe) && isRunnableFile(exe)) found.add(path.resolve(exe));
  };

  if (configured) add(configured);
  if (process.env.JAVA_HOME) add(path.join(process.env.JAVA_HOME, 'bin', 'java.exe'));

  runtimeCandidates(path.join(dataDir, 'runtimes')).forEach(add);

  const programDirs = [
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Microsoft',
    'C:\\Program Files\\Zulu',
    'C:\\Program Files\\BellSoft',
    'C:\\Program Files\\Amazon Corretto',
    path.join(process.env.LOCALAPPDATA || '', 'Programs')
  ];

  for (const root of programDirs) {
    for (const dir of listDirs(root)) {
      add(path.join(dir, 'bin', 'java.exe'));
      // Vendors nest the JDK one level down (e.g. Programs\Eclipse Adoptium\jdk-21).
      for (const inner of listDirs(dir)) add(path.join(inner, 'bin', 'java.exe'));
    }
  }

  add('C:\\Program Files\\Common Files\\Oracle\\Java\\javapath\\java.exe');
  return [...found];
}

function whereJava() {
  return new Promise((resolve) => {
    execFile('where', ['java'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      resolve(stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    });
  });
}

async function findInstalled(dataDir, configured) {
  const candidates = new Set(staticCandidates(dataDir, configured));
  (await whereJava()).forEach((exe) => candidates.add(path.resolve(exe)));

  // One unusable java.exe (Store stub, blocked or corrupt download) must not
  // fail the whole scan — probe each candidate independently.
  const probed = await Promise.all([...candidates].map((exe) => probe(exe).catch(() => null)));

  // Vendor folders alias the same install (jdk-21, latest\jdk-21, javapath),
  // so list each physical runtime once.
  const seen = new Set();
  const unique = [];
  for (const runtime of probed) {
    if (!runtime) continue;
    let key = runtime.path.toLowerCase();
    try { key = fs.realpathSync(runtime.path).toLowerCase(); } catch (err) { /* keep the literal path */ }
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(runtime);
  }
  return unique.sort((a, b) => b.major - a.major);
}

function requiredMajor(versionJson, gameVersion) {
  const declared = versionJson?.javaVersion?.majorVersion;
  if (declared) return Number(declared);

  const [major, minor] = String(gameVersion).split('.').map(Number);
  if (major === 1 && minor <= 16) return 8;
  if (major === 1 && minor <= 18) return 17;
  return 21;
}

async function installRuntime(major, dataDir, onProgress) {
  const runtimesDir = path.join(dataDir, 'runtimes');
  const target = path.join(runtimesDir, `jre-${major}`);
  const zipPath = path.join(runtimesDir, `jre-${major}.zip`);
  const url = `https://api.adoptium.net/v3/binary/latest/${major}/ga/windows/x64/jre/hotspot/normal/eclipse`;

  onProgress?.({ phase: 'java', message: `Downloading Java ${major}`, done: 0, total: 1, ratio: 0 });
  await download(url, zipPath, {
    onBytes: (chunk, bytes, total) => onProgress?.({
      phase: 'java',
      message: `Downloading Java ${major}`,
      bytes,
      ratio: total ? Math.min(1, bytes / total) : 0
    })
  });

  onProgress?.({ phase: 'java', message: `Unpacking Java ${major}`, done: 0, total: 1, ratio: 0.9 });
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  extractZip(zipPath, target);
  fs.rmSync(zipPath, { force: true });

  const exe = runtimeCandidates(runtimesDir).find((p) => p.startsWith(target));
  if (!exe) throw new Error(`Java ${major} unpacked but java.exe was not found.`);

  const result = await probe(exe);
  if (!result) throw new Error(`Java ${major} is installed but will not start.`);
  return { ...result, source: 'downloaded' };
}

/* A newer JDK can run a modern Minecraft, but only a few majors ahead: old
   1.8-era Forge breaks on 17+, and older Fabric builds pin ASM to their JDK. */
const MAX_NEWER_MAJOR = 4;

/* Prefer a runtime that already exists, exact major first, then the closest
   newer one for modern versions. Only when nothing usable is installed does
   this download a runtime. */
async function resolveJava({ dataDir, configured, major, autoInstall, onProgress }) {
  const installed = await findInstalled(dataDir, configured);
  const exact = installed.find((j) => j.major === major);

  if (exact) {
    onProgress?.({ phase: 'java', message: `Using Java ${exact.version}`, done: 1, total: 1, ratio: 1 });
    return { ...exact, source: 'installed' };
  }

  const newer = major >= 17
    ? installed
      .filter((j) => j.major > major && j.major - major <= MAX_NEWER_MAJOR)
      .sort((a, b) => a.major - b.major)[0]
    : null;

  if (newer) {
    // 1.21.11 ships asking for Java 21; an installed JDK 25 is fine for it.
    onProgress?.({
      phase: 'java',
      message: `Using Java ${newer.version} for Minecraft's Java ${major}`,
      done: 1, total: 1, ratio: 1
    });
    return { ...newer, source: 'installed' };
  }

  if (!autoInstall) {
    throw new Error(`Minecraft needs Java ${major} and it is not installed. Turn on automatic Java install or point Settings at a Java ${major} runtime.`);
  }

  const java = await installRuntime(major, dataDir, onProgress);
  onProgress?.({ phase: 'java', message: `Java ${major} ready`, done: 1, total: 1, ratio: 1 });
  return java;
}

module.exports = { majorOf, probe, findInstalled, requiredMajor, resolveJava, installRuntime };
