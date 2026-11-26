/* Wallet and daily-reward calls for the Flash store API. The store runs as a
   child of the content server, which proxies /api/store/* on the same host.
   Use the same configured backend as the news feed; localhost is only a
   last-resort fallback for local development. */

const { configuredUrl } = require('./content');
const TIMEOUT_MS = 8000;

function baseUrl() {
  if (process.env.FLASH_STORE_URL) return String(process.env.FLASH_STORE_URL).replace(/\/+$/, '');
  if (process.env.FLASH_FRIENDS_URL) return String(process.env.FLASH_FRIENDS_URL).replace(/\/+$/, '');
  return (configuredUrl() || 'http://localhost:3000').replace(/\/+$/, '');
}

async function apiRequest(endpoint, options = {}) {
  const url = `${baseUrl()}${endpoint}`;
  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : {};
    } catch (err) {
      data = { ok: false, error: 'The store server did not return JSON.' };
    }

    if (!response.ok && data && data.ok === undefined) {
      data.ok = false;
      data.error = data.error || `Store server returned ${response.status}.`;
    }
    return data || { ok: false, error: `Store server returned ${response.status}.` };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      ok: false,
      error: timedOut ? 'The store server timed out.' : 'Could not reach the store server.'
    };
  }
}

function getDailyStatus(uuid) {
  return apiRequest(`/api/store/daily?uuid=${encodeURIComponent(uuid)}`);
}

function claimDaily(uuid) {
  return apiRequest('/api/store/daily', { method: 'POST', body: { uuid } });
}

function getWallet(uuid) {
  return apiRequest(`/api/store/wallet?uuid=${encodeURIComponent(uuid)}`);
}

module.exports = {
  baseUrl,
  getDailyStatus,
  claimDaily,
  getWallet
};
