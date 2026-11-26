const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { configuredUrl } = require('./content');
const { gameDir } = require('./profiles');

/* The launcher edits the exact file the in-game locker uses
   (config/flashclient-cosmetics.properties inside the profile's game folder),
   so a pick made here is what the client wears on the next launch — and a pick
   made in-game shows up here instead of fighting it. */

const TIMEOUT_MS = 8000;
const CATALOG_TTL_MS = 10 * 60 * 1000;
const ID_RE = /^[a-z0-9_]{1,48}$/;
const SLOT_KEYS = { wings: 'equipped', cape: 'cape', hat: 'hat' };
const TYPES = new Set(['wings', 'cape', 'hat']);
const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

let cache = null;

function cacheFile() {
  return path.join(app.getPath('userData'), 'cosmetics-cache.json');
}

function propertiesFile(profileId) {
  return path.join(gameDir(profileId), 'config', 'flashclient-cosmetics.properties');
}

function cleanId(value) {
  const id = String(value || '').trim().toLowerCase();
  return ID_RE.test(id) ? id : '';
}

function readSelection(profileId) {
  let text = '';
  try { text = fs.readFileSync(propertiesFile(profileId), 'utf8'); } catch (err) { text = ''; }
  const field = (key) => {
    const match = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
    return cleanId(match ? match[1] : '');
  };
  return { wings: field(SLOT_KEYS.wings), cape: field(SLOT_KEYS.cape), hat: field(SLOT_KEYS.hat) };
}

function writeSelection(profileId, selection) {
  const file = propertiesFile(profileId);
  const values = {
    equipped: cleanId(selection?.wings),
    cape: cleanId(selection?.cape),
    hat: cleanId(selection?.hat)
  };
  // Plain key=value lines: java.util.Properties reads them back unchanged.
  const body = `${SLOT_KEYS.wings}=${values.equipped}\n${SLOT_KEYS.cape}=${values.cape}\n${SLOT_KEYS.hat}=${values.hat}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.rmSync(temp, { force: true });
  fs.writeFileSync(temp, body, 'utf8');
  fs.renameSync(temp, file);
  return { wings: values.equipped, cape: values.cape, hat: values.hat };
}

function requestJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const secure = url.startsWith('https:');
    const client = secure ? https : http;
    const req = client.get(url, {
      agent: secure ? httpsAgent : undefined,
      headers: { accept: 'application/json' }
    }, (res) => {
      const location = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && location && redirects < 3) {
        res.resume();
        resolve(requestJson(new URL(location, url).toString(), redirects + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Content server returned ${res.statusCode}.`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 4 * 1024 * 1024) req.destroy(new Error('Cosmetic catalog was too large.'));
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error('The content server did not return JSON.'));
        }
      });
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('Content server timed out.')));
    req.on('error', reject);
  });
}

function readCache(base) {
  try {
    const all = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    return all?.[base] || null;
  } catch (err) {
    return null;
  }
}

function writeCache(base, data) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) || {}; } catch (err) { all = {}; }
  all[base] = { fetchedAt: Date.now(), data };
  try {
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
    fs.writeFileSync(cacheFile(), JSON.stringify(all));
  } catch (err) {
    /* The catalog still reaches the window without a cache. */
  }
}

function cleanItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = cleanId(raw.id);
  const type = String(raw.type || '').toLowerCase();
  if (!id || !TYPES.has(type)) return null;
  const preview = String(raw.files?.preview?.url || '');
  const price = Number.isFinite(Number(raw.price)) ? Math.max(0, Math.floor(Number(raw.price))) : 0;
  return {
    id,
    type,
    name: String(raw.name || id).slice(0, 64),
    description: String(raw.description || '').slice(0, 240),
    rarity: String(raw.rarity || 'common').toLowerCase(),
    price,
    preview: /^https?:\/\//i.test(preview) ? preview : ''
  };
}

async function fetchOwned(base, uuid) {
  if (!uuid) return null;
  try {
    const payload = await requestJson(`${base}/api/cosmetics/owned?uuid=${encodeURIComponent(uuid)}`);
    return new Set(Array.isArray(payload?.owned) ? payload.owned.map(cleanId).filter(Boolean) : []);
  } catch (err) {
    return null;
  }
}

/* One round trip per profile open: cached catalog is reused for ten minutes,
   and the owned list decides which paid items can actually be worn. */
async function state(profileId, uuid) {
  const base = configuredUrl();
  const selection = readSelection(profileId);
  if (!base) {
    return { success: false, error: 'No content server is configured.', selection, items: [], store: '' };
  }

  let payload = null;
  let stale = false;
  const cached = readCache(base);
  if (cached?.data && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) {
    payload = cached.data;
  } else {
    try {
      payload = await requestJson(`${base}/api/cosmetics`);
      writeCache(base, payload);
    } catch (err) {
      payload = cached?.data || null;
      stale = Boolean(payload);
    }
  }
  if (!payload) {
    return { success: false, error: 'The cosmetic catalog is unreachable.', selection, items: [], store: '' };
  }

  const owned = await fetchOwned(base, uuid);
  const items = (Array.isArray(payload.items) ? payload.items : [])
    .map(cleanItem)
    .filter(Boolean)
    .map((item) => ({
      ...item,
      // The in-game locker refuses paid items the account does not own, and so
      // does this tab. When the owned list is unavailable, paid items stay locked.
      locked: item.price > 0 && !owned?.has(item.id)
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    success: true,
    selection,
    items,
    stale,
    store: /^https?:\/\//i.test(String(payload.store || '')) ? String(payload.store) : ''
  };
}

function select(profileId, patch) {
  const current = readSelection(profileId);
  const next = { ...current };
  for (const slot of Object.keys(SLOT_KEYS)) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, slot)) {
      next[slot] = cleanId(patch[slot]);
    }
  }
  return { success: true, selection: writeSelection(profileId, next) };
}

module.exports = { state, select, readSelection, writeSelection, propertiesFile };
