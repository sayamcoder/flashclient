const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  discordRpc: true,
  minigame: true,
  newsButton: true,
  minimizeOnLaunch: true,
  autoInstallJava: true,
  performanceMods: true,
  autoUpdate: true,
  javaPath: '',
  defaultRam: 4,
  playEdition: 'java',
  horizonPath: '',
  /* Rust Edition always launches direct (`horizon-launcher play`) regardless
     of this value, but we keep the default true so manually linked installs
     behave the same way if anything else reads it. */
  horizonDirect: true,
  /* Close-to-tray stays on by default: the whole point is that a stray click
     on X must not end a running game. */
  runInBackground: true,
  backgroundNotice: true
};

let cache = null;

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function settings() {
  if (cache) return cache;
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch (err) {
    saved = {};
  }
  cache = { ...DEFAULTS, ...saved };
  return cache;
}

function update(patch) {
  const next = { ...settings() };
  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in (patch || {}))) continue;
    if (typeof DEFAULTS[key] === 'boolean') next[key] = Boolean(patch[key]);
    else if (typeof DEFAULTS[key] === 'number') {
      const n = Number(patch[key]);
      if (Number.isFinite(n)) next[key] = Math.min(Math.max(n, 1), 32);
    } else next[key] = String(patch[key]);
  }

  cache = next;
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(next, null, 2));
  return next;
}

module.exports = { settings, update, file, DEFAULTS };
