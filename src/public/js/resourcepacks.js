/* Resource Packs tab — install, enable and order resource packs for a profile.
   Self-contained so it does not depend on helpers from mods.js. */

const RESOURCEPACKS_MODES = ['installed', 'browse'];
let resourcepacksMode = RESOURCEPACKS_MODES.includes(localStorage.getItem('flash_resourcepacks_mode'))
  ? localStorage.getItem('flash_resourcepacks_mode')
  : 'installed';
let installedPacks = [];
let browsePacks = [];
let browsePackTotal = 0;
let browsePackError = '';
let browsePackLoading = false;
let browsePackToken = 0;
let rpQuery = '';
let rpFilterTimer = null;
const packsInstalling = new Set();
let packsProfileId = null;

function packEsc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function packLoaderLabel(loader) {
  return { vanilla: 'Vanilla', forge: 'Forge', fabric: 'Fabric', neoforge: 'NeoForge' }[loader] || loader;
}

function packFormatCount(n) {
  if (!n) return '0';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function packFormatSize(bytes) {
  if (!bytes) return '—';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function packIconTile(title) {
  const letter = (title || '?').trim().charAt(0).toUpperCase();
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="6" fill="#1b1d23"/><text x="20" y="26" text-anchor="middle" font-family="monospace" font-size="15" fill="#7b8089">${letter}</text></svg>`
  );
}

function packIconTag(title, icon) {
  const fallback = packIconTile(title);
  return `<img src="${packEsc(icon || fallback)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${fallback}'"
    class="w-10 h-10 rounded-md object-cover bg-white/[0.06] border border-white/[0.06] shrink-0" />`;
}

function packProfile() {
  const profiles = typeof PROFILES !== 'undefined' ? PROFILES : [];
  return profiles.find((p) => p.id === packsProfileId)
    || (typeof activeProfile === 'function' ? activeProfile() : null)
    || { id: '1.8.9', gameVersion: '1.8.9', loader: 'forge' };
}

function packTarget() {
  const profile = packProfile();
  return { profileId: profile.id, gameVersion: profile.gameVersion, loader: profile.loader };
}

function setPacksProfile(id) {
  packsProfileId = id;
  installedPacks = [];
  browsePacks = [];
  browsePackTotal = 0;
  browsePackError = '';
  refreshResourcepacks();
}

/* ---------- chrome ---------- */

function updateResourcepacksChrome() {
  const env = packTarget();
  const scope = `${env.gameVersion} · ${packLoaderLabel(env.loader)}`;

  const installedTab = document.getElementById('resourcepacks-tab-installed');
  const browseTab = document.getElementById('resourcepacks-tab-browse');
  for (const [tab, mode] of [[installedTab, 'installed'], [browseTab, 'browse']]) {
    if (!tab) continue;
    tab.className = `px-2.5 py-1 text-[11px] font-medium rounded cursor-pointer ${resourcepacksMode === mode ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white'}`;
  }

  const subtitle = document.getElementById('resourcepacks-subtitle');
  if (subtitle) {
    if (resourcepacksMode === 'installed') {
      const active = installedPacks.filter((pack) => pack.active).length;
      subtitle.textContent = installedPacks.length
        ? `${installedPacks.length} installed · ${active} enabled · ${scope}`
        : `No resource packs · ${scope}`;
    } else if (browsePackLoading) {
      subtitle.textContent = `Searching Modrinth · ${scope}`;
    } else {
      subtitle.textContent = `${browsePackTotal} ${browsePackTotal === 1 ? 'pack' : 'packs'} on Modrinth · ${scope}`;
    }
  }

  const searchRow = document.getElementById('resourcepacks-search-row');
  const searchInput = document.getElementById('resourcepack-search-input');
  searchRow?.classList.toggle('hidden', resourcepacksMode !== 'browse');
  if (searchInput && document.activeElement !== searchInput) {
    searchInput.value = rpQuery;
  }

  const list = document.getElementById('resourcepacks-list');
  if (list) list.className = 'flex flex-col gap-2 pb-4';
}

/* ---------- rows ---------- */

function installedPackRow(pack, index) {
  return `
    <div class="flex items-center gap-3 bg-white/[0.03] border border-white/[0.07] rounded-lg px-3.5 py-3">
      ${packIconTag(pack.name, null)}
      <div class="flex-1 min-w-0">
        <h4 class="text-[12px] font-semibold truncate ${pack.active ? 'text-white' : 'text-white/45'}">${packEsc(pack.name)}</h4>
        <p class="text-[11px] font-mono text-white/35 mt-1 truncate">${packEsc(packFormatSize(pack.size))}${pack.active ? ' · Enabled' : ''}</p>
      </div>

      <div class="flex items-center gap-1.5">
        <label class="relative inline-flex items-center cursor-pointer mr-1" title="Enable or disable">
          <input type="checkbox" onchange="toggleResourcepack(${index}, this.checked)" ${pack.active ? 'checked' : ''} class="sr-only peer">
          <div class="w-8 h-[18px] bg-white/[0.08] rounded-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white/50 after:rounded-full after:h-3.5 after:w-3.5 after:transition-all peer-checked:after:translate-x-[14px] peer-checked:after:bg-white peer-checked:bg-[#4cbb5e]"></div>
        </label>

        <button type="button" onclick="removeResourcepack(${index})" aria-label="Remove ${packEsc(pack.name)}"
                class="w-7 h-7 flex items-center justify-center rounded text-white/25 hover:text-[#e0685d] hover:bg-white/[0.06] transition-colors cursor-pointer">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path></svg>
        </button>
      </div>
    </div>`;
}

function browsePackRow(pack, index) {
  const busy = packsInstalling.has(pack.id);

  let action;
  if (busy) {
    action = '<span class="h-7 px-2.5 rounded-md bg-white/[0.08] text-[11px] font-medium text-white/45 flex items-center">Installing…</span>';
  } else {
    action = `<button type="button" onclick="installResourcepack(${index})"
      class="h-7 px-2.5 rounded-md bg-white hover:bg-white/90 text-[#0b0b0e] text-[11px] font-semibold transition-colors cursor-pointer">Install</button>`;
  }

  return `
    <div class="flex items-start gap-3 bg-white/[0.03] border border-white/[0.07] hover:border-white/[0.12] rounded-lg px-3.5 py-3 transition-colors">
      ${packIconTag(pack.title, pack.icon)}
      <div class="flex-1 min-w-0">
        <div class="flex items-baseline gap-2 min-w-0">
          <h4 class="text-[12px] font-semibold text-white truncate">${packEsc(pack.title)}</h4>
          <span class="text-[11px] text-white/30 truncate">by ${packEsc(pack.author || 'unknown')}</span>
        </div>
        <p class="text-[11px] text-white/45 mt-1 leading-relaxed line-clamp-2">${packEsc(pack.description)}</p>
        <p class="text-[11px] font-mono text-white/30 mt-1.5">${packFormatCount(pack.downloads)} downloads</p>
      </div>
      <div class="shrink-0 pt-0.5">${action}</div>
    </div>`;
}

function packEmptyBlock(message, actionLabel, action) {
  return `
    <div class="flex flex-col items-center justify-center text-center py-16">
      <p class="text-[12px] text-white/45 max-w-[400px] leading-relaxed">${message}</p>
      ${actionLabel ? `<button type="button" onclick="${action}"
        class="mt-3 h-8 px-3 rounded-md bg-white/10 hover:bg-white/15 text-[11px] font-medium text-white transition-colors cursor-pointer">${actionLabel}</button>` : ''}
    </div>`;
}

/* ---------- render ---------- */

function renderResourcepacksList() {
  const list = document.getElementById('resourcepacks-list');
  if (!list) return;
  updateResourcepacksChrome();

  if (resourcepacksMode === 'installed') {
    list.innerHTML = installedPacks.length
      ? installedPacks.map(installedPackRow).join('')
      : packEmptyBlock(`No resource packs installed for ${packEsc(packTarget().gameVersion)} yet.`, 'Browse Modrinth', "setResourcepacksMode('browse')");
    return;
  }

  if (browsePackLoading) {
    list.innerHTML = packEmptyBlock('Searching Modrinth…');
    return;
  }
  if (browsePackError) {
    list.innerHTML = packEmptyBlock(packEsc(browsePackError), 'Try again', 'runPackBrowse()');
    return;
  }
  if (!browsePacks.length) {
    const env = packTarget();
    list.innerHTML = rpQuery
      ? packEmptyBlock(`Nothing on Modrinth matches that for ${packEsc(env.gameVersion)} · ${packLoaderLabel(env.loader)}.`)
      : packEmptyBlock(`No resource packs listed for ${packEsc(env.gameVersion)} · ${packLoaderLabel(env.loader)} yet.`);
    return;
  }

  list.innerHTML = browsePacks.map(browsePackRow).join('');
}

/* ---------- data ---------- */

async function refreshResourcepacks() {
  const list = document.getElementById('resourcepacks-list');
  if (!list) return;
  if (!window.electronAPI?.listResourcepacks) {
    list.innerHTML = packEmptyBlock('Resource packs are managed by the desktop app.');
    return;
  }

  if (resourcepacksMode === 'installed') {
    installedPacks = await window.electronAPI.listResourcepacks({
      profileId: packTarget().profileId,
      gameVersion: packTarget().gameVersion
    });
    renderResourcepacksList();
    return;
  }

  await runPackBrowse();
}

async function runPackBrowse() {
  const token = ++browsePackToken;
  const env = packTarget();

  browsePackLoading = true;
  renderResourcepacksList();

  const [result, installed] = await Promise.all([
    window.electronAPI.searchResourcepacks({ query: rpQuery, gameVersion: env.gameVersion, loader: env.loader }),
    window.electronAPI.listResourcepacks({ profileId: env.profileId, gameVersion: env.gameVersion })
  ]);
  if (token !== browsePackToken) return;

  browsePackLoading = false;
  browsePackError = result?.success ? '' : (result?.message || 'Search failed.');
  browsePacks = result?.hits || [];
  browsePackTotal = result?.total || 0;
  installedPacks = installed || [];
  renderResourcepacksList();
}

/* ---------- actions ---------- */

function setResourcepacksMode(mode) {
  resourcepacksMode = RESOURCEPACKS_MODES.includes(mode) ? mode : 'installed';
  localStorage.setItem('flash_resourcepacks_mode', resourcepacksMode);
  refreshResourcepacks();
}

function filterResourcepacks(text) {
  rpQuery = text;
  clearTimeout(rpFilterTimer);
  rpFilterTimer = setTimeout(runPackBrowse, 350);
}

async function installResourcepack(index) {
  const pack = browsePacks[index];
  if (!pack || packsInstalling.has(pack.id)) return;

  const env = packTarget();
  packsInstalling.add(pack.id);
  renderResourcepacksList();

  const result = await window.electronAPI.installResourcepack({
    profileId: env.profileId,
    projectId: pack.id,
    gameVersion: env.gameVersion,
    loader: env.loader
  });
  packsInstalling.delete(pack.id);

  if (!result?.success) {
    showToast(result?.message || 'Install failed.', 'error');
    renderResourcepacksList();
    return;
  }

  installedPacks = await window.electronAPI.listResourcepacks({ profileId: env.profileId, gameVersion: env.gameVersion });
  renderResourcepacksList();
  showToast(`${pack.title} installed.`, 'success');
}

async function applyEnabledPacks() {
  const filenames = installedPacks.filter((pack) => pack.active).map((pack) => pack.filename);
  const result = await window.electronAPI.setActiveResourcepacks({
    profileId: packTarget().profileId,
    filenames
  });
  if (!result?.success) {
    showToast(result?.message || 'Could not update enabled packs.', 'error');
    return false;
  }
  return true;
}

async function toggleResourcepack(index, enabled) {
  const pack = installedPacks[index];
  if (!pack) return;

  pack.active = enabled;
  const ok = await applyEnabledPacks();
  if (!ok) {
    pack.active = !enabled;
    renderResourcepacksList();
    return;
  }

  renderResourcepacksList();
  showToast(
    enabled ? `${pack.name} enabled.` : `${pack.name} disabled.`,
    enabled ? 'success' : 'info'
  );
}

async function removeResourcepack(index) {
  const pack = installedPacks[index];
  if (!pack) return;

  const result = await window.electronAPI.removeResourcepack({
    profileId: packTarget().profileId,
    filename: pack.filename
  });
  if (!result?.success) {
    showToast(result?.message || 'Could not remove that pack.', 'error');
    return;
  }

  installedPacks = await window.electronAPI.listResourcepacks({
    profileId: packTarget().profileId,
    gameVersion: packTarget().gameVersion
  });
  renderResourcepacksList();
  showToast(`${pack.name} removed.`, 'info');
}

function openResourcepacksFolder() {
  window.electronAPI?.openResourcepacksFolder?.({ profileId: packTarget().profileId });
}