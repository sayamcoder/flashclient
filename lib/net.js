const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USER_AGENT = 'FlashClient/1.0.4 (Minecraft launcher)';
const REQUEST_TIMEOUT_MS = 30000;
const REQUEST_ATTEMPTS = 2;

/* Mojang's CDN drops single requests from time to time; one failed fetch used
   to surface as "Could not reach Mojang" on the version picker. Retry network
   errors and 5xx, and let a timeout stand in for a hung socket. */
async function request(url, headers) {
  let lastError = null;
  for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok || (res.status < 500 && res.status !== 429)) return res;
      lastError = new Error(`Request failed (${res.status}): ${url}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < REQUEST_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
  }
  throw lastError;
}

async function fetchJson(url) {
  const res = await request(url, { 'User-Agent': USER_AGENT, Accept: 'application/json' });
  if (!res.ok) throw new Error(`Request failed (${res.status}): ${url}`);
  return res.json();
}

async function fetchText(url) {
  const res = await request(url, { 'User-Agent': USER_AGENT });
  if (!res.ok) throw new Error(`Request failed (${res.status}): ${url}`);
  return res.text();
}

/* Several asset names can share one hash, and two profiles can install the same
   version at once, so parallel calls may target the same file. They share one
   download instead of fighting over a single .part file. */
const inFlight = new Map();

async function download(url, destination, options = {}) {
  const key = path.resolve(destination);
  const running = inFlight.get(key);
  if (running) return running;

  const task = downloadOnce(url, destination, options).finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}

/* Streams to a temp file and only renames it into place once the bytes are
   complete, so an interrupted download never looks like a finished one. */
const DOWNLOAD_ATTEMPTS = 3;
const IDLE_TIMEOUT_MS = 60000;

function hostOf(url) {
  try { return new URL(url).host; } catch (err) { return 'the download server'; }
}

/* VPNs and flaky routes drop a connection in the middle of a file more often
   than a whole session; the launcher retries the file instead of sending the
   player back to the Play screen with undici's raw "fetch failed". */
async function fetchToFile(url, destination, { expectedSize, digestAlgo, digestValue, onBytes }) {
  const controller = new AbortController();
  let idle = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
  const kick = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
  };

  // A second launcher process may be fetching the same file; a shared .part
  // name would let one process' rename delete the other's work.
  const tmp = `${destination}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}.part`;
  let out = null;

  try {
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
    if (!response.ok || !response.body) {
      const err = new Error(`Download failed (${response.status}): ${path.basename(destination)}`);
      err.status = response.status;
      throw err;
    }

    out = fs.createWriteStream(tmp);
    kick();
    const hash = digestAlgo ? crypto.createHash(digestAlgo) : null;
    const reader = response.body.getReader();
    const total = expectedSize || Number(response.headers.get('content-length')) || 0;
    let bytes = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        kick();
        bytes += chunk.length;
        hash?.update(chunk);
        if (onBytes) onBytes(chunk.length, bytes, total);
        if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
      }
      await new Promise((resolve, reject) => {
        out.end(resolve);
        out.on('error', reject);
      });
    } catch (err) {
      out.destroy();
      fs.rmSync(tmp, { force: true });
      throw err;
    }

    if (digestAlgo && hash.digest('hex') !== digestValue) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`Checksum mismatch: ${path.basename(destination)}`);
    }

    try {
      fs.renameSync(tmp, destination);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      // Another process may have put the same file in place a moment earlier.
      let settled = null;
      try { settled = fs.statSync(destination); } catch (statErr) { settled = null; }
      const ok = settled && (!expectedSize || settled.size === expectedSize);
      if (!ok) throw err;
    }
    return { skipped: false, bytes };
  } finally {
    clearTimeout(idle);
    if (out && !out.closed) out.destroy();
  }
}

async function downloadOnce(url, destination, options = {}) {
  const { expectedSize, sha1, sha512, onBytes } = options;
  const digestAlgo = sha512 ? 'sha512' : sha1 ? 'sha1' : null;
  const digestValue = (sha512 || sha1 || '').toLowerCase();
  let existing = null;
  try {
    existing = fs.statSync(destination);
  } catch (err) {
    existing = null;
  }

  if (existing) {
    if (digestAlgo) {
      const hash = crypto.createHash(digestAlgo);
      hash.update(fs.readFileSync(destination));
      if (hash.digest('hex') === digestValue) return { skipped: true, bytes: 0 };
    } else if (!expectedSize || existing.size === expectedSize) {
      // Files this launcher wrote are only renamed into place when complete.
      return { skipped: true, bytes: 0 };
    }
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });

  let lastError = null;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      return await fetchToFile(url, destination, { expectedSize, digestAlgo, digestValue, onBytes });
    } catch (err) {
      lastError = err;
      const retriable = !(err.status && err.status < 500 && err.status !== 429);
      if (!retriable || attempt === DOWNLOAD_ATTEMPTS) break;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }

  if (lastError?.message?.startsWith('Download failed') || lastError?.message?.startsWith('Checksum')) {
    throw lastError;
  }
  throw new Error(`Could not connect to ${hostOf(url)}. Check your internet or VPN and try again.`);
}

async function mapLimit(items, limit, worker) {
  const list = Array.from(items);
  const results = new Array(list.length);
  let index = 0;

  const runners = Array.from({ length: Math.min(limit, list.length) }, async () => {
    for (;;) {
      const current = index;
      index += 1;
      if (current >= list.length) return;
      results[current] = await worker(list[current], current);
    }
  });

  await Promise.all(runners);
  return results;
}

module.exports = { USER_AGENT, fetchJson, fetchText, download, mapLimit };
