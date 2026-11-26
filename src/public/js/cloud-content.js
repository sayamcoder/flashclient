/* Live content. News and partnered servers come from the content server set in
   src/content-server.json; news.js and servers.js keep the bundled fallback. */

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatNewsDate(value) {
  const raw = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return escapeHtml(raw);
  const date = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return escapeHtml(raw);
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function applyContentResult(result) {
  if (result?.success && result.data && Array.isArray(result.data.news)) {
    NEWS_ITEMS = result.data.news;
    serversList = Array.isArray(result.data.servers) ? result.data.servers : [];
  } else {
    NEWS_ITEMS = BUNDLED_NEWS;
    serversList = BUNDLED_SERVERS.slice();
  }

  if (typeof renderNewsFeed === 'function') renderNewsFeed();
  if (typeof renderServersList === 'function') renderServersList();
  if (!document.getElementById('quick-flyout')?.classList.contains('hidden') && typeof renderQuickOptions === 'function') {
    renderQuickOptions();
  }
  if (typeof refreshServerStatus === 'function') refreshServerStatus();
}

async function refreshContent() {
  const result = await window.electronAPI?.fetchContent?.();
  if (result) applyContentResult(result);
  return result;
}

document.addEventListener('DOMContentLoaded', () => {
  refreshContent();
});
