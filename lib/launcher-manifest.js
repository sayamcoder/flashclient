const fs = require('fs');
const path = require('path');

/* The in-game mod reads this file once at startup and applies the skin and
   cape to the local player. It lives in the game directory next to
   options.txt, so it is always written for the profile being launched. */

const MANIFEST_NAME = 'flashclient-launcher.json';
const ASSET_DIR = 'flashclient';
const MAX_MANIFEST_BYTES = 8 * 1024;
const MAX_ASSET_BYTES = 512 * 1024;
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24) return null;
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function dataUrlPng(value) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/i.exec(String(value || '').trim());
  if (!match) return null;
  const bytes = Buffer.from(match[1], 'base64');
  if (!bytes.length || bytes.length > MAX_ASSET_BYTES) return null;
  return bytes;
}

function writeAtomic(file, bytes) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.rmSync(temp, { force: true });
  fs.writeFileSync(temp, bytes);
  fs.renameSync(temp, file);
}

function unlinkIfSymlink(file) {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) fs.unlinkSync(file);
  } catch (err) {
    /* nothing there */
  }
}

/* Relative paths keep the manifest valid when the game folder moves. */
function prepareAsset(gameDir, name, bytes) {
  const dir = path.join(gameDir, ASSET_DIR);
  let existing = null;
  try { existing = fs.lstatSync(dir); } catch (err) { existing = null; }
  if (existing?.isSymbolicLink()) throw new Error('The flashclient folder is a symlink.');

  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  unlinkIfSymlink(file);
  writeAtomic(file, bytes);
  return `${ASSET_DIR}/${name}`;
}

/* Mojang's profile API still hands out http:// textures.minecraft.net links;
   the host serves https, and only https is accepted in the manifest. */
function textureUrl(raw) {
  const value = String(raw || '').trim()
    .replace(/^http:\/\/textures\.minecraft\.net\//i, 'https://textures.minecraft.net/');
  if (!/^https:\/\/\S+$/i.test(value) || value.length > 800) return null;
  return value;
}

function skinValue(gameDir, skin) {
  const raw = String(skin?.skinUrl || '').trim();
  if (!raw) return null;

  if (/^data:/i.test(raw)) {
    const bytes = dataUrlPng(raw);
    const size = bytes && pngSize(bytes);
    // Premium accounts often still wear the legacy 64x32 layout.
    if (!size || size.width !== 64 || (size.height !== 64 && size.height !== 32)) return null;
    return prepareAsset(gameDir, 'skin.png', bytes);
  }

  return textureUrl(raw);
}

function capeValue(gameDir, cape) {
  const raw = String(typeof cape === 'string' ? cape : cape?.capeUrl || '').trim();
  if (!raw) return null;

  if (/^data:/i.test(raw)) {
    const bytes = dataUrlPng(raw);
    const size = bytes && pngSize(bytes);
    if (!size || size.width !== 64 || (size.height !== 32 && size.height !== 64)) return null;
    return prepareAsset(gameDir, 'cape.png', bytes);
  }

  return textureUrl(raw);
}

function write({ gameDir, username, skin, cape }) {
  const name = String(username || '').trim();
  if (!USERNAME_RE.test(name)) {
    throw new Error('Username must be 3-16 letters, numbers or underscores.');
  }
  if (!gameDir) throw new Error('No game folder to write to.');

  const manifest = { username: name };

  const skinPath = skinValue(gameDir, skin);
  if (skinPath) manifest.skin = skinPath;

  const capePath = capeValue(gameDir, cape);
  if (capePath) manifest.cape = capePath;

  if (skinPath) manifest.model = String(skin?.type || '').toLowerCase() === 'slim' ? 'slim' : 'wide';

  const bytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  if (bytes.length >= MAX_MANIFEST_BYTES) throw new Error('Launcher manifest is too large.');

  fs.mkdirSync(gameDir, { recursive: true });
  const file = path.join(gameDir, MANIFEST_NAME);
  unlinkIfSymlink(file);
  writeAtomic(file, bytes);

  return { written: true, file, manifest };
}

function remove(gameDir) {
  if (!gameDir) return { removed: false };
  const file = path.join(gameDir, MANIFEST_NAME);
  fs.rmSync(file, { force: true });
  return { removed: !fs.existsSync(file), file };
}

module.exports = { write, remove, pngSize, MANIFEST_NAME };
