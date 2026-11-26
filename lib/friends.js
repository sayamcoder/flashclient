/* Friends live on the Flash content server. Use the same deployed URL as the
   news feed (src/content-server.json / FLASH_CONTENT_URL), with localhost only
   as a last-resort fallback for local development. FLASH_FRIENDS_URL still
   overrides everything for custom setups. */

const { configuredUrl } = require('./content');
const TIMEOUT_MS = 8000;

function baseUrl() {
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
      data = { ok: false, error: 'The friends server did not return JSON.' };
    }

    // The server answers 4xx with { ok:false, error } for normal problems such
    // as "that player could not be found", so pass the body through untouched.
    if (!response.ok && data && data.ok === undefined) data.ok = false;
    return data || { ok: false, error: `Friends server returned ${response.status}.` };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      ok: false,
      error: timedOut ? 'The friends server timed out.' : 'Could not reach the friends server.'
    };
  }
}

function syncFriends(uuid, name) {
  return apiRequest('/api/friends/sync', { method: 'POST', body: { uuid, name } });
}

function lookupFriend(name) {
  return apiRequest(`/api/friends/lookup?name=${encodeURIComponent(name)}`);
}

function sendFriendRequest(uuid, name, targetUuid, targetName) {
  return apiRequest('/api/friends/request', {
    method: 'POST',
    body: { uuid, name, target: { uuid: targetUuid, name: targetName } }
  });
}

function acceptFriendRequest(uuid, name, targetUuid) {
  return apiRequest('/api/friends/accept', {
    method: 'POST',
    body: { uuid, name, target: targetUuid }
  });
}

function declineFriendRequest(uuid, name, targetUuid) {
  return apiRequest('/api/friends/decline', {
    method: 'POST',
    body: { uuid, name, target: targetUuid }
  });
}

function removeFriend(uuid, name, targetUuid) {
  return apiRequest('/api/friends/remove', {
    method: 'POST',
    body: { uuid, name, target: targetUuid }
  });
}

function sendGameInvite(code, uuid, name, targetUuid) {
  return apiRequest('/api/friends/invite', {
    method: 'POST',
    body: { code, uuid, name, to: targetUuid }
  });
}

function joinWorld(code, uuid, name) {
  return apiRequest('/api/friends/join', {
    method: 'POST',
    body: { code, uuid, name }
  });
}

function sendChatMessage(uuid, name, targetUuid, text) {
  return apiRequest('/api/friends/chat', {
    method: 'POST',
    body: { uuid, name, target: targetUuid, text }
  });
}

function getChatHistory(uuid, peerUuid, since = 0) {
  return apiRequest(
    `/api/friends/chat?uuid=${encodeURIComponent(uuid)}&peer=${encodeURIComponent(peerUuid)}&since=${Number(since) || 0}`
  );
}

function getOnlinePlayers() {
  return apiRequest('/api/client/players');
}

module.exports = {
  baseUrl,
  syncFriends,
  lookupFriend,
  sendFriendRequest,
  acceptFriendRequest,
  declineFriendRequest,
  removeFriend,
  sendGameInvite,
  joinWorld,
  sendChatMessage,
  getChatHistory,
  getOnlinePlayers
};