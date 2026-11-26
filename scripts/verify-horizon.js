/* Tests for the Horizon detection + bootstrap surface.

   Run with: node scripts/verify-horizon.js

   The point of these checks is that a player who installed Horizon anywhere
   reasonable is found without touching Settings, and that a player who has not
   installed it gets the guided steps rather than a dead-end error. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

const root = path.resolve(__dirname, '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-horizon-'));

/* A stand-in %LOCALAPPDATA% so the candidate list is deterministic and the
   test never depends on what is actually installed on this machine. */
const fakeLocal = path.join(sandbox, 'LocalAppData');
const fakeRoaming = path.join(sandbox, 'AppData');
const fakePF = path.join(sandbox, 'ProgramFiles');
const fakePFx86 = path.join(sandbox, 'ProgramFilesX86');
const fakeProgramData = path.join(sandbox, 'ProgramData');
for (const dir of [fakeLocal, fakeRoaming, fakePF, fakePFx86, fakeProgramData]) {
  fs.mkdirSync(dir, { recursive: true });
}

const saved = {
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  APPDATA: process.env.APPDATA,
  ProgramFiles: process.env.ProgramFiles,
  'ProgramFiles(x86)': process.env['ProgramFiles(x86)'],
  ProgramData: process.env.ProgramData,
  PATH: process.env.PATH,
  USERPROFILE: process.env.USERPROFILE
};
Object.assign(process.env, {
  LOCALAPPDATA: fakeLocal,
  APPDATA: fakeRoaming,
  ProgramFiles: fakePF,
  'ProgramFiles(x86)': fakePFx86,
  ProgramData: fakeProgramData,
  PATH: sandbox,
  USERPROFILE: path.join(sandbox, 'User')
});

const horizon = require(path.join(root, 'lib', 'horizon.js'));

function installAt(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, horizon.EXE);
  fs.writeFileSync(exe, 'stub');
  return exe;
}

function wipe() {
  for (const dir of [fakeLocal, fakeRoaming, fakePF, fakePFx86, fakeProgramData]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
  const user = path.join(sandbox, 'User');
  fs.rmSync(user, { recursive: true, force: true });
  fs.mkdirSync(user, { recursive: true });
  process.env.PATH = sandbox;
}

console.log('horizon detection');

check('empty machine reports not found', () => {
  wipe();
  const status = horizon.status('');
  assert.strictEqual(status.found, false);
  assert.strictEqual(status.path, '');
});

check('finds the documented per-user install', () => {
  wipe();
  const exe = installAt(path.join(fakeLocal, 'Programs', 'Horizon Launcher'));
  assert.strictEqual(horizon.status('').path, exe);
});

check('finds the no-space folder name', () => {
  wipe();
  const exe = installAt(path.join(fakeLocal, 'Programs', 'HorizonLauncher'));
  assert.strictEqual(horizon.status('').path, exe);
});

check('finds a machine-wide install under Program Files', () => {
  wipe();
  const exe = installAt(path.join(fakePF, 'Horizon Launcher'));
  assert.strictEqual(horizon.status('').path, exe);
});

check('finds a 32-bit install under Program Files (x86)', () => {
  wipe();
  const exe = installAt(path.join(fakePFx86, 'Horizon'));
  assert.strictEqual(horizon.status('').path, exe);
});

check('finds an install the player pointed at explicitly', () => {
  wipe();
  const exe = installAt(path.join(sandbox, 'Somewhere Else'));
  assert.strictEqual(horizon.status(exe).path, exe);
});

check('an explicit path that does not exist falls back to scanning', () => {
  wipe();
  const exe = installAt(path.join(fakeLocal, 'Programs', 'Horizon Launcher'));
  assert.strictEqual(horizon.status('C:\\nope\\horizon-launcher.exe').path, exe);
});

check('finds an install that is only on PATH', () => {
  wipe();
  const exe = installAt(path.join(sandbox, 'bin'));
  process.env.PATH = path.join(sandbox, 'bin');
  assert.strictEqual(horizon.status('').path, exe);
});

/* The start-menu walk is the fallback when the uninstall registry is
   unreadable, which happens on locked-down machines where `reg` is blocked.
   It must not depend on any child process. */
check('finds an install through its Start menu entry', () => {
  wipe();
  const menu = path.join(fakeRoaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Horizon');
  const exe = installAt(menu);
  assert.strictEqual(horizon.status('').path, exe);
});

console.log('bootstrap guidance');

check('bootstrap says nothing is installed yet', () => {
  const info = horizon.bootstrapInfo();
  assert.strictEqual(info.found, false);
  assert.ok(info.steps.length >= 3, 'expected setup steps');
  assert.ok(info.requirements.length >= 2, 'expected requirements');
});

check('bootstrap links only the official pages', () => {
  const info = horizon.bootstrapInfo();
  for (const url of [info.installPage, info.releasesPage]) {
    assert.ok(url.startsWith('https://playhorizon.dev/'), `unexpected host in ${url}`);
  }
});

check('bootstrap never offers an unofficial mirror', () => {
  const blob = JSON.stringify(horizon.bootstrapInfo()).toLowerCase();
  for (const bad of ['horizonlauncher.net', 'horizonmc.info', 'mirror', 'github.com/playhorizon']) {
    assert.ok(!blob.includes(bad), `mirror leaked into guidance: ${bad}`);
  }
});

check('the note explains that Horizon ships no game files', () => {
  assert.ok(/no game files/i.test(horizon.bootstrapInfo().note));
});

check('requirements name the Microsoft account and 26.3', () => {
  const text = horizon.bootstrapInfo().requirements.join(' ').toLowerCase();
  assert.ok(text.includes('microsoft account'));
  assert.ok(text.includes('26.3'));
});

console.log('launch hand-off');

check('launching without Horizon fails with the guidance attached', () => {
  wipe();
  const result = horizon.launch({ exe: '', direct: true });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.found, false);
  assert.ok(Array.isArray(result.steps) && result.steps.length > 0);
  assert.strictEqual(result.installPage, 'https://playhorizon.dev/docs/install');
});

check('launch arguments stay empty unless direct is asked for', () => {
  const source = fs.readFileSync(path.join(root, 'lib', 'horizon.js'), 'utf8');
  assert.ok(/direct \? \['play'\] : \[\]/.test(source), 'direct flag no longer gates the play arg');
});

check('the module exports the async status the IPC handler calls', () => {
  assert.strictEqual(typeof horizon.statusAsync, 'function');
  assert.strictEqual(typeof horizon.resolve, 'function');
  assert.strictEqual(typeof horizon.bootstrapInfo, 'function');
  assert.strictEqual(typeof horizon.install, 'function');
  assert.strictEqual(typeof horizon.pollForInstall, 'function');
});

check('install rejects a missing installer file', () => {
  const result = horizon.install({ exe: 'C:\\no\\such\\installer.exe' });
  assert.strictEqual(result.success, false);
  assert.ok(result.message.includes('does not exist'));
});

check('install accepts a real file and runs it detached', () => {
  /* Use node.exe itself as a stand-in installer so the spawn actually works
     without us needing to ship a fake PE file. */
  const installer = process.execPath;
  const result = horizon.install({ exe: installer });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.path, installer);
  assert.ok(Number.isFinite(result.pid));
});

check('pollForInstall finds a newly installed exe within the timeout', async () => {
  wipe();
  const target = path.join(fakeLocal, 'Programs', 'Horizon Launcher');
  const promise = horizon.pollForInstall({ interval: 100, timeout: 2000 });
  setTimeout(() => installAt(target), 250);
  const found = await promise;
  assert.strictEqual(found.found, true);
  assert.ok(found.path.startsWith(target));
});

check('pollForInstall returns false when nothing appears', async () => {
  wipe();
  const found = await horizon.pollForInstall({ interval: 50, timeout: 150 });
  assert.strictEqual(found.found, false);
});

console.log('main-process wiring');

check('main.js is not still calling the sync status on the IPC path', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.ok(
    /ipcMain\.handle\('horizon-status', \(\) => horizon\.statusAsync/.test(main),
    'horizon-status should use the async resolver'
  );
});

check('main.js exposes the download opener and the bootstrap handler', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.ok(main.includes("'horizon-open-download'"));
  assert.ok(main.includes("'horizon-bootstrap'"));
  assert.ok(main.includes("'horizon-pick-installer'"));
  assert.ok(main.includes("'horizon-install'"));
});

check('horizon-launch always uses direct mode for Rust Edition', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const block = main.slice(main.indexOf("'horizon-launch'"), main.indexOf("'horizon-launch'") + 900);
  assert.ok(block.includes('direct: true'), 'Rust launch must be direct');
  assert.ok(!block.includes('settings.horizonDirect'), 'Rust launch must not read the old toggle');
});

check('the download opener picks the URL itself', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const block = main.slice(main.indexOf("'horizon-open-download'"), main.indexOf("'horizon-open-download'") + 700);
  assert.ok(block.includes('horizon.DETAILS'), 'URL should come from the module, not the caller');
});

check('preload passes install and installer-picker channels through', () => {
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  assert.ok(preload.includes("pickHorizonInstaller: () => ipcRenderer.invoke('horizon-pick-installer')"));
  assert.ok(preload.includes("installHorizon: (installerPath) => ipcRenderer.invoke('horizon-install', installerPath)"));
});

check('the setup modal exists in the rendered play view', () => {
  const play = fs.readFileSync(path.join(root, 'src', 'views', 'partials', 'play.ejs'), 'utf8');
  assert.ok(play.includes('horizon-setup-modal'));
  assert.ok(play.includes('horizonSetupDownload'));
  assert.ok(play.includes('horizonSetupInstallFromFile'));
});

console.log('renderer wiring');

check('play.js walks the player through setup instead of dead-ending', () => {
  const play = fs.readFileSync(path.join(root, 'src', 'public', 'js', 'play.js'), 'utf8');
  assert.ok(play.includes('offerHorizonInstall'));
  assert.ok(!play.includes('Horizon launcher was not found. Link it in Settings.'));
});

check('the setup prompt lists the requirements and the steps', () => {
  const play = fs.readFileSync(path.join(root, 'src', 'public', 'js', 'play.js'), 'utf8');
  assert.ok(/info\?\.requirements \|\| \[\]\)\.map/.test(play));
  assert.ok(/info\?\.steps \|\| \[\]\)\.map/.test(play));
});

check('settings.js can open the official download page', () => {
  const settings = fs.readFileSync(path.join(root, 'src', 'public', 'js', 'settings.js'), 'utf8');
  assert.ok(settings.includes('async function openHorizonDownload'));
});

check('the settings card has a Get button bound to it', () => {
  const ejs = fs.readFileSync(path.join(root, 'src', 'views', 'partials', 'settings.ejs'), 'utf8');
  assert.ok(/onclick="openHorizonDownload\(\)"/.test(ejs));
});

check('the settings card states the Java Edition prerequisite', () => {
  const ejs = fs.readFileSync(path.join(root, 'src', 'views', 'partials', 'settings.ejs'), 'utf8');
  assert.ok(/no game files/i.test(ejs));
});

/* restore + cleanup */
for (const [key, value] of Object.entries(saved)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
fs.rmSync(sandbox, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
