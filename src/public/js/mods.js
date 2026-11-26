/* The Mods page is backed by Modrinth and by the jars actually sitting in the
   instance folder: Browse installs real files, Installed renames them to
   `.jar.disabled` to switch them off. */

const MODS_MODES = ['installed', 'browse', 'modpacks'];
let modsMode = MODS_MODES.includes(localStorage.getItem('flash_mods_mode'))
  ? localStorage.getItem('flash_mods_mode')
  : 'installed';
let installedMods = [];
let browseMods = [];
let browseTotal = 0;
let browseError = '';
let browseLoading = false;
let browseToken = 0;
let modQuery = '';
let filterTimer;
const installing = new Set();
let modsProfileId = null;

/* Modpacks are their own tab: each one installs into a fresh profile, so the
   list only needs to know which projects already have one. */
let packMods = [];
let packTotal = 0;
let packError = '';
let packLoading = false;
let packToken = 0;
let packQuery = '';
let packFilterTimer;
const packInstalling = new Map();
const packInstalled = new Map();

/* Mods live inside a profile, and a profile is one game version + loader.
   The header picker chooses which profile's mods this page is managing. */
function modProfile() {
  const profiles = typeof PROFILES !== 'undefined' ? PROFILES : [];
  return profiles.find((p) => p.id === modsProfileId)
    || (typeof activeProfile === 'function' ? activeProfile() : null)
    || { id: '1.8.9', gameVersion: '1.8.9', loader: 'forge' };
}

function modTarget() {
  const profile = modProfile();
  return { profileId: profile.id, gameVersion: profile.gameVersion, loader: profile.loader };
}

function setModsProfile(id) {
  modsProfileId = id;
  installedMods = [];
  browseMods = [];
  browseTotal = 0;
  browseError = '';
  packMods = [];
  packTotal = 0;
  packError = '';
  refreshMods();
}

function loaderLabel(loader) {
  return { vanilla: 'Vanilla', forge: 'Forge', fabric: 'Fabric', neoforge: 'NeoForge' }[loader] || loader;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function formatCount(n) {
  if (!n) return '0';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function formatSize(bytes) {
  if (!bytes) return '—';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function iconTile(title) {
  const letter = (title || '?').trim().charAt(0).toUpperCase();
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="6" fill="#1b1d23"/><text x="20" y="26" text-anchor="middle" font-family="monospace" font-size="15" fill="#7b8089">${letter}</text></svg>`
  );
}

function iconTag(title, icon) {
  const fallback = iconTile(title);
  return `<img src="${esc(icon || fallback)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${fallback}'"
    class="w-10 h-10 rounded-md object-cover bg-white/[0.06] border border-white/[0.06] shrink-0" />`;
}

/* ---------- chrome ---------- */

function updateModsChrome() {
  const env = modTarget();
  const scope = `${env.gameVersion} · ${loaderLabel(env.loader)}`;

  const picker = document.getElementById('mods-profile-select');
  if (picker) {
    const profiles = typeof PROFILES !== 'undefined' ? PROFILES : [];
    if (!profiles.some((p) => p.id === env.profileId)) modsProfileId = env.profileId;

    const label = (p) => `${p.gameVersion} · ${loaderLabel(p.loader)}`;
    const counts = new Map();
    for (const p of profiles) counts.set(label(p), (counts.get(label(p)) || 0) + 1);

    picker.innerHTML = profiles
      .map((p) => {
        const base = label(p);
        const text = counts.get(base) > 1 ? `${base} · ${p.name}` : base;
        return `<option value="${esc(p.id)}" ${p.id === env.profileId ? 'selected' : ''}>${esc(text)}</option>`;
      })
      .join('');
    picker.title = picker.options[picker.selectedIndex]?.textContent || '';
    picker.classList.toggle('hidden', profiles.length < 2);
  }

  const installedTab = document.getElementById('mods-tab-installed');
  const browseTab = document.getElementById('mods-tab-browse');
  const packsTab = document.getElementById('mods-tab-modpacks');
  for (const [tab, mode] of [[installedTab, 'installed'], [browseTab, 'browse'], [packsTab, 'modpacks']]) {
    if (!tab) continue;
    tab.className = `px-2.5 py-1 text-[11px] font-medium rounded cursor-pointer ${modsMode === mode ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white'}`;
  }

  const subtitle = document.getElementById('mods-subtitle');
  if (subtitle) {
    if (modsMode === 'installed') {
      subtitle.textContent = installedMods.length
        ? `${installedMods.length} installed · ${scope}`
        : `Nothing installed · ${scope}`;
    } else if (modsMode === 'modpacks') {
      subtitle.textContent = packLoading
        ? `Searching Modrinth · ${scope}`
        : `${packTotal} ${packTotal === 1 ? 'modpack' : 'modpacks'} · ${scope}`;
    } else if (browseLoading) {
      subtitle.textContent = `Searching Modrinth · ${scope}`;
    } else {
      subtitle.textContent = `${browseTotal} ${browseTotal === 1 ? 'mod' : 'mods'} on Modrinth · ${scope}`;
    }
  }

  const searchRow = document.getElementById('mods-search-row');
  const searchInput = document.getElementById('mod-search-input');
  const searching = modsMode === 'browse' || modsMode === 'modpacks';
  searchRow?.classList.toggle('hidden', !searching);
  if (searchInput) {
    searchInput.placeholder = modsMode === 'modpacks' ? 'Search modpacks' : 'Search Modrinth';
    // Progress ticks re-render the list; rewriting the field mid-typing would
    // move the caret to the end.
    if (document.activeElement !== searchInput) {
      searchInput.value = modsMode === 'modpacks' ? packQuery : modQuery;
    }
  }

  const note = document.getElementById('mods-pack-note');
  if (note) {
    note.classList.toggle('hidden', modsMode !== 'modpacks');
    note.classList.toggle('flex', modsMode === 'modpacks');
  }

  const list = document.getElementById('mods-list');
  if (list) {
    list.className = modsMode === 'modpacks'
      ? 'grid grid-cols-2 gap-2 pb-4'
      : 'flex flex-col gap-2 pb-4';
  }
}

/* ---------- rows ---------- */

function installedRow(mod, index) {
  const meta = [mod.versionNumber, formatSize(mod.size), mod.projectId ? null : mod.filename].filter(Boolean).join(' · ');

  return `
    <div class="flex items-center gap-3 bg-white/[0.03] border border-white/[0.07] rounded-lg px-3.5 py-3">
      ${iconTag(mod.title, mod.icon)}
      <div class="flex-1 min-w-0">
        <h4 class="text-[12px] font-semibold truncate ${mod.enabled ? 'text-white' : 'text-white/45'}">${esc(mod.title)}</h4>
        <p class="text-[11px] font-mono text-white/35 mt-1 truncate">${esc(meta)}</p>
      </div>

      <label class="relative inline-flex items-center cursor-pointer">
        <input type="checkbox" onchange="toggleInstalledMod(${index}, this.checked)" ${mod.enabled ? 'checked' : ''} class="sr-only peer">
        <div class="w-8 h-[18px] bg-white/[0.08] rounded-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white/50 after:rounded-full after:h-3.5 after:w-3.5 after:transition-all peer-checked:after:translate-x-[14px] peer-checked:after:bg-white peer-checked:bg-[#4cbb5e]"></div>
      </label>

      <button type="button" onclick="removeInstalledMod(${index})" aria-label="Remove ${esc(mod.title)}"
              class="w-7 h-7 flex items-center justify-center rounded text-white/25 hover:text-[#e0685d] hover:bg-white/[0.06] transition-colors cursor-pointer">
        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path></svg>
      </button>
    </div>`;
}

function browseRow(mod, index) {
  const installed = installedMods.some((entry) => entry.projectId === mod.id);
  const busy = installing.has(mod.id);

  let action;
  if (installed) {
    action = '<span class="h-7 px-2.5 rounded-md bg-white/[0.06] text-[11px] font-medium text-white/45 flex items-center">Installed</span>';
  } else if (busy) {
    action = '<span class="h-7 px-2.5 rounded-md bg-white/[0.08] text-[11px] font-medium text-white/45 flex items-center">Installing…</span>';
  } else {
    action = `<button type="button" onclick="installMod(${index})"
      class="h-7 px-2.5 rounded-md bg-white hover:bg-white/90 text-[#0b0b0e] text-[11px] font-semibold transition-colors cursor-pointer">Install</button>`;
  }

  return `
    <div class="flex items-start gap-3 bg-white/[0.03] border border-white/[0.07] hover:border-white/[0.12] rounded-lg px-3.5 py-3 transition-colors">
      ${iconTag(mod.title, mod.icon)}
      <div class="flex-1 min-w-0">
        <div class="flex items-baseline gap-2 min-w-0">
          <h4 class="text-[12px] font-semibold text-white truncate">${esc(mod.title)}</h4>
          <span class="text-[11px] text-white/30 truncate">by ${esc(mod.author || 'unknown')}</span>
        </div>
        <p class="text-[11px] text-white/45 mt-1 leading-relaxed line-clamp-2">${esc(mod.description)}</p>
        <p class="text-[11px] font-mono text-white/30 mt-1.5">${formatCount(mod.downloads)} downloads</p>
      </div>
      <div class="shrink-0 pt-0.5">${action}</div>
    </div>`;
}

/* ---------- modpack cards ---------- */

function packIcon(title, icon) {
  const fallback = iconTile(title);
  return `<img src="${esc(icon || fallback)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${fallback}'"
    class="w-11 h-11 rounded-lg object-cover bg-white/[0.06] border border-white/[0.06] shrink-0" />`;
}

/* A pack card is a two-line pitch plus one button: the scope (version and
   loader) is already on every card, so the card itself only carries the pack. */
function packRow(pack, index) {
  const progress = packInstalling.get(pack.id);
  const profileId = packInstalled.get(pack.id);
  const pct = Math.round(Math.min(1, Math.max(0, progress?.ratio || 0)) * 100);

  let action;
  if (progress) {
    action = `<span class="h-7 px-2.5 rounded-md bg-white/[0.08] text-[11px] font-mono text-white/55 flex items-center tabular-nums">${pct}%</span>`;
  } else if (profileId) {
    action = `<button type="button" onclick="openPackProfile('${esc(profileId)}')"
      class="h-7 px-2.5 rounded-md bg-white/[0.06] hover:bg-white/[0.1] text-[11px] font-medium text-white/70 hover:text-white transition-colors cursor-pointer">Play</button>`;
  } else {
    action = `<button type="button" onclick="installPack(${index})"
      class="h-7 px-2.5 rounded-md bg-white hover:bg-white/90 text-[#0b0b0e] text-[11px] font-semibold transition-colors cursor-pointer">Install</button>`;
  }

  return `
    <div class="bg-white/[0.03] border border-white/[0.07] hover:border-white/[0.12] rounded-lg p-3.5 flex flex-col transition-colors">
      <div class="flex items-start gap-3">
        ${packIcon(pack.title, pack.icon)}
        <div class="flex-1 min-w-0 pt-0.5">
          <h4 class="text-[12px] font-semibold text-white truncate">${esc(pack.title)}</h4>
          <p class="text-[11px] text-white/35 mt-1 truncate">by ${esc(pack.author || 'unknown')}</p>
        </div>
      </div>

      <p class="text-[11px] text-white/45 leading-relaxed line-clamp-2 mt-2.5">${esc(pack.description)}</p>

      <div class="flex items-end justify-between gap-2 mt-auto pt-3">
        <span class="text-[10px] font-mono text-white/40 truncate tabular-nums">${progress
          ? esc(progress.message || 'Working…')
          : `${formatCount(pack.downloads)} downloads`}</span>
        ${action}
      </div>

      ${progress ? `
      <div class="mt-3 -mx-3.5 -mb-3.5 h-[3px] bg-white/[0.05] overflow-hidden rounded-b-lg">
        <div class="h-full bg-white/35 transition-[width] duration-300" style="width:${Math.max(2, pct)}%"></div>
      </div>` : ''}
    </div>`;
}

function emptyBlock(message, actionLabel, action) {  return `
    <div class="flex flex-col items-center justify-center text-center py-16">
      <p class="text-[12px] text-white/45 max-w-[400px] leading-relaxed">${message}</p>
      ${actionLabel ? `<button type="button" onclick="${action}"
        class="mt-3 h-8 px-3 rounded-md bg-white/10 hover:bg-white/15 text-[11px] font-medium text-white transition-colors cursor-pointer">${actionLabel}</button>` : ''}
    </div>`;
}

/* ---------- render ---------- */

function renderModsList() {
  const list = document.getElementById('mods-list');
  if (!list) return;
  updateModsChrome();

  if (modsMode === 'modpacks') {
    if (packLoading) {
      list.innerHTML = emptyBlock('Searching Modrinth…');
      return;
    }
    if (packError) {
      list.innerHTML = emptyBlock(esc(packError), 'Try again', 'runPackSearch()');
      return;
    }
    if (!packMods.length) {
      const env = modTarget();
      list.innerHTML = packQuery
        ? emptyBlock(`Nothing on Modrinth matches that for ${esc(env.gameVersion)} · ${loaderLabel(env.loader)}.`)
        : emptyBlock(`No modpacks listed for ${esc(env.gameVersion)} · ${loaderLabel(env.loader)} yet.`);
      return;
    }

    list.innerHTML = packMods.map(packRow).join('');
    return;
  }

  if (modsMode === 'installed') {
    list.innerHTML = installedMods.length
      ? installedMods.map(installedRow).join('')
      : emptyBlock(`No mods installed for ${esc(modTarget().gameVersion)} yet.`, 'Browse Modrinth', "setModsMode('browse')");
    return;
  }

  if (browseLoading) {
    list.innerHTML = emptyBlock('Searching Modrinth…');
    return;
  }
  if (browseError) {
    list.innerHTML = emptyBlock(esc(browseError), 'Try again', 'runSearch()');
    return;
  }
  if (!browseMods.length) {
    const env = modTarget();
    list.innerHTML = modQuery
      ? emptyBlock(`Nothing on Modrinth matches that for ${esc(env.gameVersion)} · ${loaderLabel(env.loader)}.`)
      : emptyBlock(`No ${loaderLabel(env.loader)} mods listed for ${esc(env.gameVersion)} yet.`);
    return;
  }

  list.innerHTML = browseMods.map(browseRow).join('');
}

/* ---------- data ---------- */

async function refreshMods() {
  const list = document.getElementById('mods-list');
  if (!list) return;

  const api = modsMode === 'modpacks' ? window.electronAPI?.searchModpacks : window.electronAPI?.searchModrinth;
  if (!api) {
    list.innerHTML = emptyBlock('Mods are managed by the desktop app.');
    return;
  }

  if (modsMode === 'installed') {
    installedMods = await window.electronAPI.listMods({
      profileId: modTarget().profileId,
      gameVersion: modTarget().gameVersion
    });
    renderModsList();
    return;
  }

  if (modsMode === 'modpacks') {
    await runPackSearch();
    return;
  }

  await runSearch();
}

async function runSearch() {
  const token = ++browseToken;
  const env = modTarget();

  browseLoading = true;
  renderModsList();

  const [result, installed] = await Promise.all([
    window.electronAPI.searchModrinth({ query: modQuery, gameVersion: env.gameVersion, loader: env.loader }),
    window.electronAPI.listMods({ profileId: env.profileId, gameVersion: env.gameVersion })
  ]);
  if (token !== browseToken) return;

  browseLoading = false;
  browseError = result?.success ? '' : (result?.message || 'Search failed.');
  browseMods = result?.mods || [];
  browseTotal = result?.total || 0;
  installedMods = installed || [];
  renderModsList();
}

async function loadInstalledPacks() {
  const packs = await window.electronAPI?.listModpacks?.();
  packInstalled.clear();
  for (const entry of packs || []) {
    if (entry?.projectId) packInstalled.set(entry.projectId, entry.profileId);
  }
}

async function runPackSearch() {
  const token = ++packToken;
  const env = modTarget();

  packLoading = true;
  packError = '';
  renderModsList();

  const [result] = await Promise.all([
    window.electronAPI.searchModpacks({ query: packQuery, gameVersion: env.gameVersion, loader: env.loader }),
    loadInstalledPacks()
  ]);
  if (token !== packToken) return;

  packLoading = false;
  packError = result?.success ? '' : (result?.message || 'Search failed.');
  packMods = result?.packs || [];
  packTotal = result?.total || 0;
  renderModsList();
}

function handlePackProgress(patch) {
  if (!patch?.projectId || !packInstalling.has(patch.projectId)) return;
  packInstalling.set(patch.projectId, { ...packInstalling.get(patch.projectId), ...patch });
  if (modsMode === 'modpacks') renderModsList();
}

/* ---------- actions ---------- */

function setModsMode(mode) {
  modsMode = MODS_MODES.includes(mode) ? mode : 'installed';
  localStorage.setItem('flash_mods_mode', modsMode);
  refreshMods();
}

function filterMods(text) {
  if (modsMode === 'modpacks') {
    packQuery = text;
    clearTimeout(packFilterTimer);
    packFilterTimer = setTimeout(runPackSearch, 350);
    return;
  }

  modQuery = text;
  clearTimeout(filterTimer);
  filterTimer = setTimeout(runSearch, 350);
}

async function installPack(index) {
  const pack = packMods[index];
  if (!pack || packInstalling.has(pack.id)) return;

  const env = modTarget();
  packInstalling.set(pack.id, { ratio: 0, message: 'Starting…' });
  renderModsList();

  const result = await window.electronAPI.installModpack({
    projectId: pack.id,
    gameVersion: env.gameVersion,
    loader: env.loader
  });
  packInstalling.delete(pack.id);

  if (!result?.success) {
    showToast(result?.message || 'Could not install that pack.', 'error');
    renderModsList();
    return;
  }

  packInstalled.set(pack.id, result.profileId);
  if (typeof loadProfiles === 'function') await loadProfiles();
  renderModsList();
  showToast(`${result.name} installed. Press Play on its card to start it.`, 'success');
}

async function openPackProfile(profileId) {
  if (typeof selectProfile === 'function') await selectProfile(profileId);
  if (typeof switchTab === 'function') switchTab('play');
}

async function installMod(index) {
  const mod = browseMods[index];
  if (!mod || installing.has(mod.id)) return;

  const env = modTarget();
  installing.add(mod.id);
  renderModsList();

  const result = await window.electronAPI.installMod({
    projectId: mod.id,
    profileId: env.profileId,
    gameVersion: env.gameVersion,
    loader: env.loader,
    icon: mod.icon,
    title: mod.title
  });
  installing.delete(mod.id);

  if (!result?.success) {
    showToast(result?.message || 'Install failed.', 'error');
    renderModsList();
    return;
  }

  installedMods = await window.electronAPI.listMods({ profileId: env.profileId, gameVersion: env.gameVersion });
  renderModsList();
  showToast(`${result.mod.title} installed.`, 'success');
}

async function toggleInstalledMod(index, enabled) {
  const mod = installedMods[index];
  if (!mod) return;

  const result = await window.electronAPI.setModEnabled({
    profileId: modTarget().profileId,
    gameVersion: modTarget().gameVersion,
    filename: mod.filename,
    enabled
  });
  if (!result?.success) showToast(result?.message || 'Could not update that mod.', 'error');

  installedMods = await window.electronAPI.listMods({
    profileId: modTarget().profileId,
    gameVersion: modTarget().gameVersion
  });
  renderModsList();
}

async function removeInstalledMod(index) {
  const mod = installedMods[index];
  if (!mod) return;

  const result = await window.electronAPI.removeMod({
    profileId: modTarget().profileId,
    gameVersion: modTarget().gameVersion,
    filename: mod.filename
  });
  if (!result?.success) {
    showToast(result?.message || 'Could not remove that mod.', 'error');
    return;
  }

  installedMods = await window.electronAPI.listMods({
    profileId: modTarget().profileId,
    gameVersion: modTarget().gameVersion
  });
  renderModsList();
  showToast(`${mod.title} removed.`, 'info');
}

function openModsFolder() {
  window.electronAPI?.openModsFolder?.({
    profileId: modTarget().profileId,
    gameVersion: modTarget().gameVersion
  });
}

document.addEventListener('DOMContentLoaded', () => {
  window.electronAPI?.onModpackProgress?.(handlePackProgress);
});
