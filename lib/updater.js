const { app } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { spawn } = require('child_process');

/* Launcher self-update.

   The feed URL is owner config (src/update-feed.json), the same way the content
   server is configured, so a release only needs a new manifest and installer —
   no code change. A manifest without a matching SHA-256 is ignored: nothing
   from the network is ever executed without a checksum to prove it.

   update.json served by the feed:
     {
       "version": "3.0.0",                       required, must be newer
       "download": "https://…/Flash-Client-Setup-3.0.0.exe",  https only
       "sha256": "…",                            required, hex of the exe
       "size": 94407125,                          required, exact bytes
       "notes": ["line", "line"],                 optional release notes
       "publishedAt": "2026-11-13",               optional date
       "minVersion": "1.0.0",                     optional, forces old builds
       "mandatory": false                         optional flag
     }
*/

const CONFIG_FILE = path.join(__dirname, '..', 'src', 'update-feed.json');
const CHECK_TIMEOUT_MS = 8000;
const DOWNLOAD_TIMEOUT_MS = 20000;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_INSTALLER_BYTES = 400 * 1024 * 1024;
const VERSION_RE = /^\d{1,3}(\.\d{1,3}){0,3}(-[0-9A-Za-z.-]{1,20})?$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

let verified = null;

function isLoopback(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

/* Plain http would let anyone on the same network swap the installer. Only the
   loopback feed used while building is allowed to skip TLS. */
function safeUrl(raw) {
  try {
    const url = new URL(String(raw || '').trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.protocol === 'http:' && !isLoopback(url.hostname)) return null;
    return url;
  } catch (err) {
    return null;
  }
}

/* The feed is either a plain update.json or a GitHub repo. A GitHub feed needs
   no server and no storage: the release tag is the version, the asset is the
   installer and GitHub stores its sha256 digest. */
function feedUrl() {
  if (process.env.FLASH_UPDATE_URL) return safeUrl(process.env.FLASH_UPDATE_URL)?.toString() || '';
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
    if (config.github) {
      const repo = String(config.github)
        .trim()
        .replace(/^https?:\/\/github\.com\//i, '')
        .replace(/\.git$/i, '');
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return '';
      const tag = String(config.tag || '').trim();
      return tag
        ? `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`
        : `https://api.github.com/repos/${repo}/releases/latest`;
    }
    return safeUrl(config.url)?.toString() || '';
  } catch (err) {
    return '';
  }
}

function pendingDir() {
  return path.join(app.getPath('userData'), 'updates');
}

function pendingFile(version) {
  const safe = String(version || '').replace(/[^0-9A-Za-z.-]/g, '_');
  return path.join(pendingDir(), `Flash-Client-Setup-${safe}.exe`);
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/* A checksum proves a file came from the feed; the PE header proves it can
   actually run. A feed pointing at the wrong file otherwise quits the launcher
   for an installer that never starts. */
function isWindowsExecutable(file) {
  try {
    const handle = fs.openSync(file, 'r');
    const head = Buffer.alloc(2);
    fs.readSync(handle, head, 0, 2, 0);
    fs.closeSync(handle);
    return head[0] === 0x4d && head[1] === 0x5a;
  } catch (err) {
    return false;
  }
}

function parseVersion(value) {
  return String(value || '')
    .trim()
    .split('-')[0]
    .split('.')
    .map((part) => parseInt(part, 10) || 0);
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, {
      headers: { accept: 'application/json', 'user-agent': `FlashClient/${app.getVersion()}` }
    }, (res) => {
      const location = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && location) {
        res.resume();
        const next = safeUrl(new URL(location, url).toString());
        if (!next) {
          reject(new Error('The update feed redirected to an unsafe address.'));
          return;
        }
        resolve(requestJson(next));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`The update feed returned ${res.statusCode}.`));
        return;
      }

      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > MAX_MANIFEST_BYTES) {
          req.destroy();
          reject(new Error('The update feed was larger than expected.'));
        }
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error('The update feed did not return JSON.'));
        }
      });
    });

    req.setTimeout(CHECK_TIMEOUT_MS, () => req.destroy(new Error('The update check timed out.')));
    req.on('error', reject);
  });
}

function cleanManifest(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const version = String(raw.version || '').trim();
  if (!VERSION_RE.test(version)) return null;

  const download = safeUrl(raw.download || raw.url);
  if (!download) return null;

  const sha256 = String(raw.sha256 || '').trim().toLowerCase();
  if (!SHA256_RE.test(sha256)) return null;

  const size = Number(raw.size);
  if (!Number.isInteger(size) || size <= 4 || size > MAX_INSTALLER_BYTES) return null;

  const noteSource = Array.isArray(raw.notes) ? raw.notes : String(raw.notes || '').split(/\r?\n/);
  const notes = noteSource
    .map((line) => String(line == null ? '' : line).trim().slice(0, 240))
    .filter(Boolean)
    .slice(0, 12);

  const publishedAt = /^\d{4}-\d{2}-\d{2}$/.test(String(raw.publishedAt || '')) ? raw.publishedAt : '';
  const minVersion = VERSION_RE.test(String(raw.minVersion || '')) ? String(raw.minVersion) : '';

  return {
    version,
    download: download.toString(),
    sha256,
    size,
    notes,
    publishedAt,
    minVersion,
    mandatory: raw.mandatory === true
  };
}

const GITHUB_RELEASE_RE = /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\//i;

/* A GitHub release carries everything a manifest needs except the version,
   which comes from the tag (v3.0.1) and falls back to the asset name. */
function manifestFromRelease(release) {
  if (!release || typeof release !== 'object' || release.draft) return null;

  const asset = (Array.isArray(release.assets) ? release.assets : [])
    .filter((item) => /\.exe$/i.test(String(item?.name || '')))
    .sort((a, b) => Number(/(setup|installer)/i.test(String(b?.name))) - Number(/(setup|installer)/i.test(String(a?.name))))[0];
  if (!asset) return null;

  const tag = String(release.tag_name || release.name || '').trim().replace(/^v/i, '');
  const fromName = (String(asset.name || '').match(/\d{1,3}(?:\.\d{1,3}){1,3}/) || [])[0] || '';
  const version = VERSION_RE.test(tag) ? tag : fromName;
  if (!version) return null;

  const digest = String(asset.digest || '').toLowerCase();
  return cleanManifest({
    version,
    download: asset.browser_download_url,
    sha256: digest.startsWith('sha256:') ? digest.slice(7) : '',
    size: asset.size,
    notes: String(release.body || '')
      .split(/\r?\n/)
      .map((line) => line.replace(/^[\s#*>-]+/, '').trim())
      .filter(Boolean)
      .slice(0, 8),
    publishedAt: String(release.published_at || '').slice(0, 10)
  });
}

/* Older uploads do not carry a digest. A release can ship an update.json next
   to the installer instead; that file is the manifest. */
async function releaseManifest(release) {
  const direct = manifestFromRelease(release);
  if (direct) return direct;

  const extra = (Array.isArray(release?.assets) ? release.assets : [])
    .find((asset) => /^update\.json$/i.test(String(asset?.name || '')));
  const url = extra ? safeUrl(extra.browser_download_url) : null;
  return url ? cleanManifest(await requestJson(url)) : null;
}

async function check(currentVersion) {
  const feed = feedUrl();
  if (!feed) return { success: false, reason: 'not-configured', current: currentVersion };

  try {
    const payload = await requestJson(new URL(feed));
    const manifest = GITHUB_RELEASE_RE.test(feed)
      ? await releaseManifest(payload)
      : cleanManifest(payload);
    if (!manifest) {
      return { success: false, reason: 'bad-manifest', feed, current: currentVersion };
    }

    const newer = compareVersions(manifest.version, currentVersion) > 0;
    const mandatory = manifest.mandatory
      || Boolean(manifest.minVersion && compareVersions(currentVersion, manifest.minVersion) < 0);

    return {
      success: true,
      feed,
      current: currentVersion,
      available: newer,
      manifest: { ...manifest, mandatory }
    };
  } catch (err) {
    return {
      success: false,
      reason: err?.code === 'ENOTFOUND' || err?.code === 'ECONNREFUSED' ? 'offline' : 'error',
      feed,
      current: currentVersion,
      message: err?.message || 'Could not reach the update server.'
    };
  }
}

function openDownload(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, {
      headers: { accept: 'application/octet-stream', 'user-agent': `FlashClient/${app.getVersion()}` }
    }, (res) => {
      const location = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && location && redirects < 3) {
        res.resume();
        const next = safeUrl(new URL(location, url).toString());
        if (!next) {
          reject(new Error('The update download redirected to an unsafe address.'));
          return;
        }
        resolve(openDownload(next, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`The update server returned ${res.statusCode}.`));
        return;
      }
      resolve(res);
    });

    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => req.destroy(new Error('The update download timed out.')));
    req.on('error', reject);
  });
}

/* Streams to a .part file so a broken connection can never leave a truncated
   installer behind, then verifies the checksum before it is renamed into place. */
async function download(manifest, { onProgress } = {}) {
  const dir = pendingDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = pendingFile(manifest.version);

  // A download cut short by closing the launcher leaves a .part behind.
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.part')) {
      try { fs.rmSync(path.join(dir, name), { force: true }); } catch (err) { /* best effort */ }
    }
  }

  if (fs.existsSync(file) && sha256File(file) === manifest.sha256) {
    verified = { version: manifest.version, file, sha256: manifest.sha256 };
    return { success: true, file, bytes: manifest.size, reused: true };
  }

  const temp = `${file}.part`;
  fs.rmSync(temp, { force: true });

  const res = await openDownload(new URL(manifest.download));
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(temp);
  let received = 0;
  let lastEmit = 0;

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        res.destroy();
        out.destroy();
        fs.rmSync(temp, { force: true });
        reject(err);
      };

      res.on('data', (chunk) => {
        received += chunk.length;
        hash.update(chunk);
        if (received > MAX_INSTALLER_BYTES || received > manifest.size) {
          fail(new Error('The update download was larger than expected.'));
          return;
        }
        const now = Date.now();
        if (onProgress && now - lastEmit > 150) {
          lastEmit = now;
          onProgress({ received, total: manifest.size, percent: Math.min(99, Math.floor((received * 100) / manifest.size)) });
        }
      });
      res.on('error', fail);
      out.on('error', fail);
      out.on('finish', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      res.pipe(out);
    });
  } catch (err) {
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
    throw err;
  }

  if (received !== manifest.size) {
    fs.rmSync(temp, { force: true });
    throw new Error('The update download stopped before the file was complete.');
  }

  const digest = hash.digest('hex');
  if (digest !== manifest.sha256) {
    fs.rmSync(temp, { force: true });
    throw new Error('The update download did not match its checksum.');
  }

  if (!isWindowsExecutable(temp)) {
    fs.rmSync(temp, { force: true });
    throw new Error('The update feed points at a file that is not a Windows installer.');
  }

  fs.renameSync(temp, file);
  if (onProgress) onProgress({ received, total: manifest.size, percent: 100 });

  for (const name of fs.readdirSync(dir)) {
    if (name !== path.basename(file) && /^Flash-Client-Setup-.*\.exe(\.part)?$/i.test(name)) {
      try { fs.rmSync(path.join(dir, name), { force: true }); } catch (err) { /* best effort */ }
    }
  }

  verified = { version: manifest.version, file, sha256: manifest.sha256 };
  return { success: true, file, bytes: manifest.size, reused: false };
}

/* A download survives the process: after a restart the installer is still in the
   updates folder, so adopt it again instead of asking for a second download. */
function recover(manifest) {
  if (!manifest || !manifest.version) return false;

  const file = pendingFile(manifest.version);
  try {
    if (!fs.existsSync(file)) return false;
    if (fs.statSync(file).size !== manifest.size) return false;
    if (sha256File(file) !== manifest.sha256) return false;
    if (!isWindowsExecutable(file)) return false;
  } catch (err) {
    return false;
  }

  verified = { version: manifest.version, file, sha256: manifest.sha256 };
  return true;
}

function install() {
  return new Promise((resolve) => {
    if (!verified || !fs.existsSync(verified.file)) {
      resolve({ success: false, message: 'There is no downloaded update to install.' });
      return;
    }

    try {
      if (sha256File(verified.file) !== verified.sha256) {
        resolve({ success: false, message: 'The downloaded installer changed on disk. Download it again.' });
        return;
      }
    } catch (err) {
      resolve({ success: false, message: 'The downloaded installer could not be read.' });
      return;
    }

    if (!isWindowsExecutable(verified.file)) {
      resolve({ success: false, message: 'The update feed served a file that is not a Windows installer.' });
      return;
    }

    // The installer replaces flash-client.exe, which Windows locks while this
    // process runs. A detached shell waits for the launcher to exit, then starts
    // NSIS silently; the installer launches the new build when it is done.
    const script = path.join(pendingDir(), 'apply-update.cmd');
    const command = [
      '@echo off',
      'timeout /t 2 /nobreak >nul',
      `start "" "${verified.file}" /S --updated`,
      'del "%~f0" >nul 2>&1'
    ].join('\r\n');

    try {
      fs.writeFileSync(script, `${command}\r\n`);
    } catch (err) {
      resolve({ success: false, message: 'The update could not prepare its installer. Try again.' });
      return;
    }

    let child;
    try {
      child = spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true });
    } catch (err) {
      resolve({ success: false, message: 'The update could not start its installer. Try again.' });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.on('error', () => finish({ success: false, message: 'The update could not start its installer. Try again.' }));
    child.on('spawn', () => {
      child.unref();
      finish({ success: true, file: verified.file });
    });
  });
}

module.exports = {
  check,
  download,
  install,
  recover,
  feedUrl,
  compareVersions,
  cleanManifest,
  pendingDir,
  pendingFile
};
