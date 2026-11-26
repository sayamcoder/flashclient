const fs = require('fs');
const path = require('path');
const { configuredUrl } = require('./content');
const { readZipEntry } = require('./zip');

/* The backend serves one build per Minecraft version. A missing build is
   normal: the launch continues without the mod. */

const FILE_NAME = 'FlashClient.jar';
const TIMEOUT_MS = 60000;
const ATTEMPTS = 3;
const MAX_BYTES = 8 * 1024 * 1024;
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/* The jar states which loader it needs ("fabricloader": ">=0.20.1"). Reading
   that lets the launcher pick a new enough loader instead of starting the
   game only to crash on an incompatible one. */
function fabricRequirement(jarPath) {
  try {
    const raw = readZipEntry(jarPath, 'fabric.mod.json');
    if (!raw) return null;
    const meta = JSON.parse(raw.toString('utf8'));
    const range = meta?.depends?.fabricloader;
    if (typeof range !== 'string') return null;
    const floor = range.match(/\d+(?:\.\d+)+/);
    return floor ? floor[0] : null;
  } catch (err) {
    return null;
  }
}

/* The URL carries a cache buster: a CDN in front of the backend happily serves
   the previous jar, which looks exactly like "the update never downloads". */
function urlFor(base, version) {
  return `${base}/api/get/${encodeURIComponent(version)}/FlashClient.jar?t=${Date.now()}`;
}

/* Slow links and flaky proxies are common, so a jar fetch gets generous time
   and a couple of retries instead of one 8 second shot. */
async function fetchJar(url) {
  let reason = 'unreachable';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: 'no-store' });
      if (res.ok) return { bytes: Buffer.from(await res.arrayBuffer()) };
      reason = `status-${res.status}`;
      if (res.status < 500) return { reason };
    } catch (err) {
      reason = err?.name === 'TimeoutError' ? 'timeout' : 'unreachable';
    }
    if (attempt < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 700 * attempt));
  }
  return { reason };
}

async function install(gameVersion, modsDir) {
  const version = String(gameVersion || '').trim();
  const base = configuredUrl();
  const target = path.join(modsDir, FILE_NAME);
  // Whatever happens with the download, a jar already in mods/ still loads, so
  // its loader requirement is reported back either way.
  const done = (result) => ({ ...result, fabricLoader: fabricRequirement(target) });

  if (!version || !base) return done({ installed: false, reason: 'not-configured' });

  try {
    const fetched = await fetchJar(urlFor(base, version));
    if (!fetched.bytes) return done({ installed: false, reason: fetched.reason });

    const bytes = fetched.bytes;
    if (bytes.length < 4 || bytes.length > MAX_BYTES || !bytes.subarray(0, 4).equals(ZIP_SIGNATURE)) {
      return done({ installed: false, reason: 'not-a-jar' });
    }

    fs.mkdirSync(modsDir, { recursive: true });

    let current = null;
    try { current = fs.readFileSync(target); } catch (err) { current = null; }
    if (current && current.equals(bytes)) {
      return done({ installed: true, updated: false, bytes: bytes.length });
    }

    // Write beside the old jar first and only swap once the new one is a real
    // mod jar. A truncated download or an error page must never replace a
    // working jar, otherwise the next offline launch has nothing to fall back to.
    const temp = path.join(modsDir, `.${FILE_NAME}.${process.pid}.tmp`);
    fs.writeFileSync(temp, bytes);

    let valid = false;
    try {
      const meta = JSON.parse(readZipEntry(temp, 'fabric.mod.json').toString('utf8'));
      valid = Boolean(meta?.id);
    } catch (err) {
      valid = false;
    }
    if (!valid) {
      try { fs.unlinkSync(temp); } catch (err) { /* temp is best-effort */ }
      return done({ installed: false, reason: 'not-a-mod' });
    }

    fs.renameSync(temp, target);
    return done({ installed: true, updated: true, bytes: bytes.length });
  } catch (err) {
    return done({ installed: false, reason: err?.name === 'TimeoutError' ? 'timeout' : 'unreachable' });
  }
}

module.exports = { install, urlFor, fabricRequirement, FILE_NAME };
