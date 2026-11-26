/* Partnered servers. Only names and addresses are stored; player counts and
   ping come from live Server List Ping results in the main process. */
const BUNDLED_SERVERS = [
  { name: 'Hypixel Network', ip: 'mc.hypixel.net', desc: 'Bedwars, SkyBlock, Duels & Minigames', tag: 'Partner' },
  { name: 'Minemen Club', ip: 'minemen.club', desc: 'Competitive Practice & Ranked 1v1 PvP', tag: 'Partner' },
  { name: 'JartexNetwork', ip: 'top.jartex.fun', desc: 'Cracked & Premium Friendly Survival / Bedwars', tag: 'Partner' },
  { name: 'PikaNetwork', ip: 'pika.host', desc: 'No.1 Ranked Cracked Minecraft Server', tag: 'Partner' }
];

let serversList = BUNDLED_SERVERS.slice();
let serverStatuses = {};

function liveStatus(server) {
  const status = serverStatuses[server.ip];
  if (!status) return { main: '—', sub: '', state: 'pending', title: 'Checking status' };
  if (!status.online) return { main: 'Offline', sub: '', state: 'offline', title: status.error || 'Server is offline' };

  const players = Number.isFinite(status.players) ? status.players.toLocaleString('en-US') : '—';
  const max = Number.isFinite(status.max) && status.max > 0 ? ` of ${status.max.toLocaleString('en-US')}` : '';
  return {
    main: players,
    sub: Number.isFinite(status.ping) ? `${status.ping}ms` : '',
    state: 'online',
    title: `${players}${max} players online${Number.isFinite(status.ping) ? ` · ${status.ping}ms` : ''}`
  };
}

function liveCountLabel(server) {
  const status = serverStatuses[server.ip];
  if (!status) return '—';
  if (!status.online) return 'Offline';
  return Number.isFinite(status.players) ? status.players.toLocaleString('en-US') : 'Online';
}

function renderServersList() {
  const container = document.getElementById('servers-list-container');
  if (!container) return;

  if (!serversList.length) {
    container.innerHTML = '<div class="rounded-lg border border-white/[0.07] bg-white/[0.02] px-4 py-6 text-center"><p class="text-[12px] text-white/40">No servers are on the list yet.</p><p class="text-[11px] text-white/25 mt-1">Add an address above to keep it handy.</p></div>';
    return;
  }

  container.innerHTML = serversList.map(server => {
    const tag = String(server.tag || '').trim();
    const first = String(server.name || '?').charAt(0);
    const status = liveStatus(server);
    const live = serverStatuses[server.ip];
    const favicon = live?.online && live.favicon ? live.favicon : '';
    const logo = String(server.logo || '').trim();
    const mainColor = status.state === 'online' ? 'text-white/65' : 'text-white/30';
    return `
    <div class="bg-white/[0.02] border border-white/[0.06] hover:bg-white/[0.035] hover:border-white/[0.12] rounded-lg px-3.5 py-3 flex items-center justify-between gap-4 transition-colors">
      <div class="flex items-center gap-3 min-w-0">
        <div class="relative w-9 h-9 rounded-md bg-white/[0.04] border border-white/[0.07] flex items-center justify-center font-mono text-[13px] text-white/45 shrink-0 overflow-hidden">
          <span>${escapeHtml(first)}</span>
          ${favicon ? `<img src="${escapeHtml(favicon)}" alt="" class="absolute inset-0 w-full h-full object-cover" onerror="this.remove()" />` : ''}
          ${logo ? `<img src="${escapeHtml(logo)}" alt="" class="absolute inset-0 w-full h-full object-cover" onerror="this.remove()" />` : ''}
        </div>
        <div class="min-w-0">
          <div class="flex items-center gap-2 min-w-0">
            <h4 class="text-[12px] font-medium text-white truncate">${escapeHtml(server.name)}</h4>
            ${tag ? `<span class="shrink-0 text-[9.5px] font-medium text-white/35 bg-white/[0.04] border border-white/[0.07] rounded px-1.5 py-[1px]">${escapeHtml(tag)}</span>` : ''}
          </div>
          <p class="text-[11px] text-white/40 ${server.desc ? 'mt-0.5' : 'hidden'} truncate">${escapeHtml(server.desc)}</p>
          <span class="block text-[11px] font-mono text-white/30 ${server.desc ? 'mt-0.5' : 'mt-1'}">${escapeHtml(server.ip)}</span>
        </div>
      </div>

      <div class="flex items-center gap-4 shrink-0">
        <div class="text-right" title="${escapeHtml(status.title)}">
          <span class="block text-[12px] font-mono ${mainColor}">${escapeHtml(status.main)}</span>
          <span class="block text-[11px] font-mono text-white/30 mt-0.5" style="visibility:${status.sub ? 'visible' : 'hidden'}">${escapeHtml(status.sub || '0ms')}</span>
        </div>
        <button type="button" data-ip="${escapeHtml(server.ip)}" onclick="copyToClipboard(this.dataset.ip)" class="btn-smooth h-7 px-3 bg-white/[0.07] hover:bg-white/[0.12] text-white text-[11px] font-medium rounded-md cursor-pointer">
          Copy IP
        </button>
      </div>
    </div>`;
  }).join('');
}

async function refreshServerStatus() {
  if (!window.electronAPI?.serversStatus) return;

  const ips = [...new Set(serversList.map((server) => String(server.ip || '').trim()).filter(Boolean))].slice(0, 60);
  if (!ips.length) {
    serverStatuses = {};
    renderServersList();
    return;
  }

  let result = null;
  try {
    result = await window.electronAPI.serversStatus(ips);
  } catch (err) {
    result = null;
  }
  if (!result?.success || !result.statuses) return;

  serverStatuses = result.statuses;
  renderServersList();
  if (typeof renderQuickOptions === 'function') renderQuickOptions();
  if (typeof updateStatusLine === 'function') updateStatusLine();
}

function copyToClipboard(text, successMsg) {
  navigator.clipboard.writeText(text);
  showToast(successMsg || 'Copied to clipboard.', 'success');
}

setInterval(() => {
  if (document.hidden) return;
  const serversView = document.getElementById('servers-view');
  const quickOpen = !document.getElementById('quick-flyout')?.classList.contains('hidden');
  if (quickOpen || (serversView && !serversView.classList.contains('hidden'))) refreshServerStatus();
}, 60000);

document.addEventListener('DOMContentLoaded', () => {
  refreshServerStatus();
});
