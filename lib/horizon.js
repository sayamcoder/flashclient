/* Horizon is the Rust rewrite of Minecraft Java Edition (playhorizon.dev).
   Its launcher ships a CLI: `horizon-launcher play` starts the game directly,
   and no argument opens the launcher window. Flash Client only needs to find
   the executable and hand off — accounts, builds and worlds stay in Horizon.

   There is no way to launch Rust Edition *without* Horizon. Horizon's own
   installer docs are explicit: it has no game files of its own. It reads
   resources from a Minecraft Java 26.3 install that the player already owns
   and has launched once, and it never downloads or shares them. So "direct
   bootstrap" here means: find Horizon, and if it is missing, walk the player
   through the official install instead of dead-ending on an error toast.

   Nothing in this file downloads an installer from the internet. The launcher
   is published on GitHub Releases behind a 404 for anonymous clients, and the
   website's release feed reports "GitHub couldn't be reached just now", so
   there is no URL we can verify a hash against. Guessing at a mirror URL is
   how players end up running someone else's binary.

   What we *do* support is running an installer the player already downloaded
   with their own browser, then polling until `horizon-launcher.exe` appears
   and launching it with `horizon-launcher play` so no Horizon window opens. */

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const EXE = process.platform === 'win32' ? 'horizon-launcher.exe' : 'horizon-launcher';

/* Only these are ours to send players to. The unofficial mirrors that rank
   for "horizon launcher download" must never appear here. */
const OFFICIAL = {
  home: 'https://playhorizon.dev/',
  install: 'https://playhorizon.dev/docs/install',
  releases: 'https://playhorizon.dev/releases',
  source: 'https://github.com/horizon-rust/horizon'
};

/* The Windows setup executable the docs tell players to download. We do not
   download it ourselves; the user points us at the file their browser saved. */
const INSTALLER_EXE = process.platform === 'win32' ? 'horizon-launcher-setup.exe' : 'horizon-launcher-setup';

/* Folder names to look under. Order matters: the per-user installer writes to
   %LOCALAPPDATA%\Programs first, so that is the most likely hit. */
const FOLDER_NAMES = [
  'Horizon Launcher',
  'HorizonLauncher',
  'horizon-launcher',
  'horizon launcher',
  'Horizon'
];

/* Other drives are common on gaming PCs: Minecraft usually is not on C:. */
function driveLetters() {
  if (process.platform !== 'win32') return [];
  const list = [];
  for (let i = 68; i <= 90; i += 1) {
    const letter = `${String.fromCharCode(i)}:`;
    try {
      if (fs.existsSync(`${letter}\\`)) list.push(letter);
    } catch { /* unreadable drive */ }
  }
  return list;
}

function installCandidates() {
  const local = process.env.LOCALAPPDATA || '';
  const roaming = process.env.APPDATA || '';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const programData = process.env.ProgramData || 'C:\\ProgramData';

  const list = [];

  /* Per-user install (the documented default: no administrator needed). */
  for (const name of FOLDER_NAMES) {
    if (local) {
      list.push(path.join(local, 'Programs', name, EXE));
      list.push(path.join(local, name, EXE));
    }
    if (roaming) list.push(path.join(roaming, name, EXE));
  }

  /* Machine-wide install, the "all users" branch of the installer. */
  for (const root of [programFiles, programFilesX86, programData]) {
    if (!root) continue;
    for (const name of FOLDER_NAMES) list.push(path.join(root, name, EXE));
  }

  /* Portable ZIP, which players extract wherever they like. */
  if (local) list.push(path.join(local, 'Programs', 'Horizon', EXE));

  /* Same layout on the remaining drives. */
  for (const drive of driveLetters()) {
    if (drive === 'C:') continue;
    for (const name of FOLDER_NAMES) {
      list.push(`${drive}\\Program Files\\${name}\\${EXE}`);
      list.push(`${drive}\\Program Files (x86)\\${name}\\${EXE}`);
      list.push(`${drive}\\${name}\\${EXE}`);
      if (local) list.push(`${drive}\\${path.basename(local)}\\Programs\\${name}\\${EXE}`);
    }
  }

  return list.filter(Boolean);
}

function fromPathVariable() {
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, EXE);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* unreadable PATH entry */ }
  }
  return '';
}

/* Read the Windows uninstall keys. A player who moved the launcher somewhere
   we would not guess is still recorded there, with the exact install path.

   This is a bonus, not a dependency: `reg` can be unavailable (a locked-down
   machine, an antivirus policy, a stripped Windows image). When it is, the
   execFile error is swallowed and the folder and shortcut probes still run,
   so detection degrades instead of failing. Measured at ~60ms when blocked. */
function fromRegistry() {
  if (process.platform !== 'win32') return Promise.resolve('');

  const roots = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
  ];

  const queryOne = (root) => new Promise((resolve) => {
    execFile(
      'reg',
      ['query', root, '/s', '/f', 'Horizon', '/t', 'REG_SZ', '/d'],
      { windowsHide: true, timeout: 6000 },
      (err, stdout) => resolve(err ? '' : String(stdout || ''))
    );
  });

  return Promise.all(roots.map(queryOne)).then((chunks) => {
    const text = chunks.join('\n');
    if (!text) return '';

    /* InstallLocation is the folder; DisplayIcon sometimes carries the exe. */
    const dirs = [...text.matchAll(/InstallLocation\s+REG_SZ\s+(.+)/gi)]
      .map((m) => m[1].trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
    for (const dir of dirs) {
      const candidate = path.join(dir, EXE);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch { /* unreadable */ }
    }

    const icons = [...text.matchAll(/DisplayIcon\s+REG_SZ\s+(.+)/gi)]
      .map((m) => m[1].trim().replace(/^"|"$/g, '').replace(/,\d+$/, ''));
    for (const icon of icons) {
      if (!/horizon/i.test(icon)) continue;
      try {
        if (fs.existsSync(icon) && path.basename(icon).toLowerCase() === EXE.toLowerCase()) return icon;
      } catch { /* unreadable */ }
    }

    return '';
  }).catch(() => '');
}

/* Start-menu and desktop shortcuts, for an install that registered neither an
   uninstall key nor a predictable folder. */
function fromShortcuts() {
  if (process.platform !== 'win32') return '';
  const roaming = process.env.APPDATA || '';
  const programData = process.env.ProgramData || '';
  if (!roaming || !programData) return '';

  const dirs = [
    path.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.USERPROFILE || '', 'Desktop'),
    path.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
  ].filter(Boolean);

  for (const dir of dirs) {
    const found = searchShortcutDir(dir, 0);
    if (found) return found;
  }
  return '';
}

function searchShortcutDir(dir, depth) {
  if (depth > 3) return '';
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return ''; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = searchShortcutDir(full, depth + 1);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name.toLowerCase() === EXE.toLowerCase()) {
      return full;
    }
  }
  return '';
}

/* Synchronous resolve, used everywhere the caller can afford to wait for a
   filesystem walk but not for a child process. Registry lives in the async
   variant below because `reg query` is slow on a cold cache. */
function resolveSync(custom) {
  const explicit = String(custom || '').trim();
  if (explicit) {
    try { if (fs.existsSync(explicit)) return explicit; } catch { /* unreadable */ }
  }
  const listed = installCandidates().find((candidate) => {
    try { return fs.existsSync(candidate); } catch { return false; }
  });
  return listed || fromShortcuts() || fromPathVariable();
}

/* Async resolve adds the registry scan. That is the slowest step, so the
   quick probes run first and usually settle the question. */
async function resolve(custom) {
  const quick = resolveSync(custom);
  if (quick) return quick;
  const registered = await fromRegistry();
  if (registered) return registered;
  return '';
}

function status(custom) {
  const exe = resolveSync(custom);
  return { found: Boolean(exe), path: exe };
}

async function statusAsync(custom) {
  const exe = await resolve(custom);
  return { found: Boolean(exe), path: exe };
}

/* The one-time preparation Horizon needs from the player. Surfaced in the UI
   so nobody installs Horizon and then wonders why Play does nothing. */
const REQUIREMENTS = [
  'A Microsoft account that owns Minecraft: Java Edition.',
  'Minecraft: Java Edition 26.3 played once, so its files are on this PC.',
  'A graphics card with Vulkan or DirectX 12 on Windows.'
];

/* What the launcher hands back when Horizon is not installed: the steps, and
   the official page to open. The renderer renders this; it never fetches. */
function bootstrapInfo() {
  return {
    found: false,
    distribution: 'horizon',
    installPage: OFFICIAL.install,
    releasesPage: OFFICIAL.releases,
    requirements: REQUIREMENTS,
    steps: [
      'Download horizon-launcher-setup.exe from the official page and run it. It installs for your account only and needs no administrator.',
      'Open Horizon once and install the newest version on its Versions page.',
      'On Play, choose Prepare so Horizon builds its resources from your own Minecraft 26.3 files.',
      'Sign in with the Microsoft account that owns Java Edition, then come back here.'
    ],
    note: 'Horizon ships no game files. It reads them from your own Minecraft 26.3 install and never downloads or shares them.'
  };
}

function launch({ exe, direct } = {}) {
  const target = resolveSync(exe);
  if (!target) {
    return { success: false, message: 'Horizon launcher was not found.', ...bootstrapInfo() };
  }

  const args = direct ? ['play'] : [];
  try {
    const child = spawn(target, args, {
      cwd: path.dirname(target),
      detached: true,
      stdio: 'ignore'
    });
    child.on('error', () => { /* reported by the caller on the next try */ });
    child.unref();
    return { success: true, path: target, direct: Boolean(direct) };
  } catch (err) {
    return { success: false, message: `Could not open Horizon: ${err.message}` };
  }
}

/* Run a downloaded installer with a silent flag. NSIS installers (common for
   Electron/Tauri apps) use `/S`. Inno Setup uses `/SILENT`. Horizon's docs do
   not say which one it is, so we try `/S` first because that is what most
   modern Windows game launchers ship. If the installer ignores the flag it
   simply shows its normal UI; the player can complete it by hand and the poll
   loop will still pick up the result. */
function install({ exe } = {}) {
  const target = String(exe || '').trim();
  if (!target) {
    return { success: false, message: 'No installer was selected.' };
  }
  try {
    if (!fs.existsSync(target)) {
      return { success: false, message: 'Installer file does not exist.' };
    }
  } catch (err) {
    return { success: false, message: `Cannot read installer: ${err.message}` };
  }

  const args = ['/S'];
  try {
    const child = spawn(target, args, {
      detached: true,
      stdio: 'ignore'
    });
    child.on('error', () => { /* spawn errors surface as the poll never finding the exe */ });
    child.unref();
    return { success: true, path: target, pid: child.pid };
  } catch (err) {
    return { success: false, message: `Could not run installer: ${err.message}` };
  }
}

/* Wait until the launcher executable appears somewhere we look. The renderer
   drives this with repeated calls so the UI can show progress and the player
   can cancel; a single long-lived handle would be harder to interrupt. */
async function pollForInstall({ interval = 2500, timeout = 180000, custom } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const found = await resolve(custom);
    if (found) return { found: true, path: found };
    await new Promise((resolveCb) => setTimeout(resolveCb, interval));
  }
  return { found: false };
}

module.exports = {
  resolve,
  resolveSync,
  status,
  statusAsync,
  launch,
  install,
  pollForInstall,
  bootstrapInfo,
  DETAILS: OFFICIAL,
  EXE,
  INSTALLER_EXE
};
