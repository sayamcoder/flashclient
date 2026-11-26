const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const TIMEOUT_MS = 7000;
const MAX_ITEMS = 100;
const MAX_BODY = 2 * 1024 * 1024;
const CONFIG_FILE = path.join(__dirname, '..', 'src', 'content-server.json');

const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

function cacheFile() {
  return path.join(app.getPath('userData'), 'content-cache.json');
}

function configuredUrl() {
  if (process.env.FLASH_CONTENT_URL) return normalizeBase(process.env.FLASH_CONTENT_URL);
  try {
    return normalizeBase(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))?.url);
  } catch (err) {
    return '';
  }
}

function normalizeBase(raw) {
  let value = String(raw || '').trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    const basePath = parsed.pathname
      .replace(/\/+$/, '')
      .replace(/\/api\/content$/i, '')
      .replace(/\/admin$/i, '');
    return `${parsed.protocol}//${parsed.host}${basePath}`;
  } catch (err) {
    return '';
  }
}

function text(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

const TONES = ['green', 'amber', 'red', 'blue'];

function cleanNews(item, index) {
  if (!item || typeof item !== 'object') return null;
  const title = text(item.title, 120);
  if (!title) return null;
  return {
    id: text(item.id, 64) || `n_cloud_${index}`,
    tag: text(item.tag, 24) || 'Update',
    tone: TONES.includes(item.tone) ? item.tone : 'green',
    title,
    body: text(item.body, 2000),
    date: text(item.date, 40),
    image: /^https?:\/\//i.test(String(item.image || '')) ? text(item.image, 500) : null,
    pinned: item.pinned === true
  };
}

function cleanServer(item, index) {
  if (!item || typeof item !== 'object') return null;
  const name = text(item.name, 48);
  const ip = text(item.ip, 128);
  if (!name || !ip) return null;
  return {
    id: text(item.id, 64) || `s_cloud_${index}`,
    name,
    ip,
    desc: text(item.description ?? item.desc, 160),
    logo: /^https?:\/\//i.test(String(item.logo || '')) ? text(item.logo, 500) : null,
    tag: text(item.tag, 24) || 'Partner',
    color: /^#[0-9a-f]{6}$/i.test(String(item.color || '')) ? item.color : '#5ec36a',
    order: Number.isFinite(Number(item.order)) ? Number(item.order) : 99
  };
}

function normalizeContent(raw) {
  return {
    version: 1,
    updatedAt: Number(raw?.updatedAt) || Date.now(),
    news: (Array.isArray(raw?.news) ? raw.news : []).slice(0, MAX_ITEMS).map(cleanNews).filter(Boolean),
    servers: (Array.isArray(raw?.servers) ? raw.servers : []).slice(0, MAX_ITEMS).map(cleanServer).filter(Boolean)
  };
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
        if (body.length > MAX_BODY) {
          req.destroy();
          reject(new Error('Content response was too large.'));
        }
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error('Content server did not return JSON.'));
        }
      });
    });

    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('Content server timed out.')));
    req.on('error', reject);
  });
}

function errorMessage(err) {
  const message = String(err?.message || '').trim();
  if (message) return message;
  if (err?.code) return err.code;
  return 'Content server unreachable.';
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
  try {
    all = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) || {};
  } catch (err) {
    all = {};
  }
  all[base] = { fetchedAt: Date.now(), data };

  const bases = Object.keys(all);
  for (const key of bases.slice(0, Math.max(0, bases.length - 5))) delete all[key];

  try {
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
    fs.writeFileSync(cacheFile(), JSON.stringify(all));
  } catch (err) {
    /* The fetch result still reaches the launcher without the cache. */
  }
}

async function fetchContent() {
  const base = configuredUrl();
  if (!base) {
    return { success: false, source: 'local', error: '' };
  }

  try {
    const payload = await requestJson(`${base}/api/content`);
    const data = normalizeContent(payload);
    writeCache(base, data);
    return {
      success: true,
      source: 'cloud',
      base,
      data,
      fetchedAt: Date.now(),
      stats: { news: data.news.length, servers: data.servers.length }
    };
  } catch (err) {
    const cached = readCache(base);
    if (cached?.data) {
      return {
        success: true,
        source: 'cache',
        base,
        stale: true,
        data: cached.data,
        fetchedAt: cached.fetchedAt,
        error: errorMessage(err),
        stats: { news: cached.data.news?.length || 0, servers: cached.data.servers?.length || 0 }
      };
    }
    return { success: false, source: 'local', base, error: errorMessage(err) };
  }
}

module.exports = { fetchContent, configuredUrl, normalizeBase, normalizeContent, cacheFile };
