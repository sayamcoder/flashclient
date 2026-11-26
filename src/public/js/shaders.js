/* Shaders tab — install and manage shaderpacks (Iris/OptiFine compatible).
   Self-contained so it does not depend on helpers from mods.js. */

const SHADERS_MODES = ['installed', 'browse'];
let shadersMode = SHADERS_MODES.includes(localStorage.getItem('flash_shaders_mode'))
  ? localStorage.getItem('flash_shaders_mode')
  : 'installed';
let installedShaders = [];
let browseShaders = [];
let shaderBrowseTotal = 0;
let shaderBrowseError = '';
let shaderBrowseLoading = false;
let shaderBrowseToken = 0;
let shaderQuery = '';
let shaderFilterTimer = null;
const shadersInstalling = new Set();
let shadersProfileId = null;

function shaderEsc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function shaderLoaderLabel(loader) {
  return { vanilla: 'Vanilla', forge: 'Forge', fabric: 'Fabric', neoforge: 'NeoForge' }[loader] || loader;
}

function shaderFormatCount(n) {
  if (!n) return '0';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function shaderFormatSize(bytes) {
  if (!bytes) return '—';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function shaderIconTile(title) {
  const letter = (title || '?').trim().charAt(0).toUpperCase();
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="6" fill="#1b1d23"/><text x="20" y="26" text-anchor="middle" font-family="monospace" font-size="15" fill="#7b8089">${letter}</text></svg>`
  );
}

function shaderIconTag(title, icon) {
  const fallback = shaderIconTile(title);
  return `<img src="${shaderEsc(icon || fallback)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${fallback}'"
    class="w-10 h-10 rounded-md object-cover bg-white/[0.06] border border-white/[0.06] shrink-0" />`;
}

function shaderProfile() {
  const profiles = typeof PROFILES !== 'undefined' ? PROFILES : [];
  return profiles.find((p) => p.id === shadersProfileId)
    || (typeof activeProfile === 'function' ? activeProfile() : null)
    || { id: '1.8.9', gameVersion: '1.8.9', loader: 'forge' };
}

function shaderTarget() {
  const profile = shaderProfile();
  return { profileId: profile.id, gameVersion: profile.gameVersion, loader: profile.loader };
}

function setShadersProfile(id) {
  shadersProfileId = id;
  installedShaders = [];
  browseShaders = [];
  shaderBrowseTotal = 0;
  shaderBrowseError = '';
  refreshShaders();
}

/* ---------- chrome ---------- */

function updateShadersChrome() {
  const env = shaderTarget();
  const scope = `${env.gameVersion} · ${shaderLoaderLabel(env.loader)}`;

  const installedTab = document.getElementById('shaders-tab-installed');
  const browseTab = document.getElementById('shaders-tab-browse');
  for (const [tab, mode] of [[installedTab, 'installed'], [browseTab, 'browse']]) {
    if (!tab) continue;
    tab.className = `px-2.5 py-1 text-[11px] font-medium rounded cursor-pointer ${shadersMode === mode ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white'}`;
  }

  const subtitle = document.getElementById('shaders-subtitle');
  if (subtitle) {
    if (shadersMode === 'installed') {
      subtitle.textContent = installedShaders.length
        ? `${installedShaders.length} installed · ${scope}`
        : `Nothing installed · ${scope}`;
    } else if (shaderBrowseLoading) {
      subtitle.textContent = `Searching Modrinth · ${scope}`;
    } else {
      subtitle.textContent = `${shaderBrowseTotal} ${shaderBrowseTotal === 1 ? 'shaderpack' : 'shaderpacks'} on Modrinth · ${scope}`;
    }
  }

  const searchRow = document.getElementById('shaders-search-row');
  const searchInput = document.getElementById('shader-search-input');
  searchRow?.classList.toggle('hidden', shadersMode !== 'browse');
  if (searchInput && document.activeElement !== searchInput) {
    searchInput.value = shaderQuery;
  }

  const list = document.getElementById('shaders-list');
  if (list) list.className = 'flex flex-col gap-2 pb-4';
}

/* ---------- rows ---------- */

function installedShaderRow(shader, index) {
  return `
    <div class="flex items-center gap-3 bg-white/[0.03] border border-white/[0.07] rounded-lg px-3.5 py-3">
      ${shaderIconTag(shader.name, null)}
      <div class="flex-1 min-w-0">
        <h4 class="text-[12px] font-semibold truncate ${shader.active ? 'text-white' : 'text-white/45'}">${shaderEsc(shader.name)}</h4>
        <p class="text-[11px] font-mono text-white/35 mt-1 truncate">${shaderEsc(shaderFormatSize(shader.size))}${shader.active ? ' · Active' : ''}</p>
      </div>

      <div class="flex items-center gap-2">
        ${shader.active
          ? '<span class="h-7 px-2.5 rounded-md bg-[#5ec36a]/20 text-[11px] font-medium text-[#5ec36a] flex items-center">Active</span>'
          : `<button type="button" onclick="setActiveShader(${index})"
                  class="h-7 px-2.5 rounded-md bg-white hover:bg-white/90 text-[#0b0b0e] text-[11px] font-semibold transition-colors cursor-pointer">Activate</button>`}
        <button type="button" onclick="removeShader(${index})" aria-label="Remove ${shaderEsc(shader.name)}"
                class="w-7 h-7 flex items-center justify-center rounded text-white/25 hover:text-[#e0685d] hover:bg-white/[0.06] transition-colors cursor-pointer">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path></svg>
        </button>
      </div>
    </div>`;
}

function browseShaderRow(shader, index) {
  const busy = shadersInstalling.has(shader.id);

  let action;
  if (busy) {
    action = '<span class="h-7 px-2.5 rounded-md bg-white/[0.08] text-[11px] font-medium text-white/45 flex items-center">Installing…</span>';
  } else {
    action = `<button type="button" onclick="installShader(${index})"
      class="h-7 px-2.5 rounded-md bg-white hover:bg-white/90 text-[#0b0b0e] text-[11px] font-semibold transition-colors cursor-pointer">Install</button>`;
  }

  return `
    <div class="flex items-start gap-3 bg-white/[0.03] border border-white/[0.07] hover:border-white/[0.12] rounded-lg px-3.5 py-3 transition-colors">
      ${shaderIconTag(shader.title, shader.icon)}
      <div class="flex-1 min-w-0">
        <div class="flex items-baseline gap-2 min-w-0">
          <h4 class="text-[12px] font-semibold text-white truncate">${shaderEsc(shader.title)}</h4>
          <span class="text-[11px] text-white/30 truncate">by ${shaderEsc(shader.author || 'unknown')}</span>
        </div>
        <p class="text-[11px] text-white/45 mt-1 leading-relaxed line-clamp-2">${shaderEsc(shader.description)}</p>
        <p class="text-[11px] font-mono text-white/30 mt-1.5">${shaderFormatCount(shader.downloads)} downloads</p>
      </div>
      <div class="shrink-0 pt-0.5">${action}</div>
    </div>`;
}

function shaderEmptyBlock(message, actionLabel, action) {
  return `
    <div class="flex flex-col items-center justify-center text-center py-16">
      <p class="text-[12px] text-white/45 max-w-[400px] leading-relaxed">${message}</p>
      ${actionLabel ? `<button type="button" onclick="${action}"
        class="mt-3 h-8 px-3 rounded-md bg-white/10 hover:bg-white/15 text-[11px] font-medium text-white transition-colors cursor-pointer">${actionLabel}</button>` : ''}
    </div>`;
}

/* ---------- render ---------- */

function renderShadersList() {
  const list = document.getElementById('shaders-list');
  if (!list) return;
  updateShadersChrome();

  if (shadersMode === 'installed') {
    list.innerHTML = installedShaders.length
      ? installedShaders.map(installedShaderRow).join('')
      : shaderEmptyBlock(`No shaderpacks installed for ${shaderEsc(shaderTarget().gameVersion)} yet.`, 'Browse Modrinth', "setShadersMode('browse')");
    return;
  }

  if (shaderBrowseLoading) {
    list.innerHTML = shaderEmptyBlock('Searching Modrinth…');
    return;
  }
  if (shaderBrowseError) {
    list.innerHTML = shaderEmptyBlock(shaderEsc(shaderBrowseError), 'Try again', 'runShaderSearch()');
    return;
  }
  if (!browseShaders.length) {
    const env = shaderTarget();
    list.innerHTML = shaderQuery
      ? shaderEmptyBlock(`Nothing on Modrinth matches that for ${shaderEsc(env.gameVersion)} · ${shaderLoaderLabel(env.loader)}.`)
      : shaderEmptyBlock(`No shaderpacks listed for ${shaderEsc(env.gameVersion)} · ${shaderLoaderLabel(env.loader)} yet.`);
    return;
  }

  list.innerHTML = browseShaders.map(browseShaderRow).join('');
}

/* ---------- data ---------- */

async function refreshShaders() {
  const list = document.getElementById('shaders-list');
  if (!list) return;
  if (!window.electronAPI?.listShaders) {
    list.innerHTML = shaderEmptyBlock('Shaders are managed by the desktop app.');
    return;
  }

  if (shadersMode === 'installed') {
    installedShaders = await window.electronAPI.listShaders({
      profileId: shaderTarget().profileId,
      gameVersion: shaderTarget().gameVersion
    });
    renderShadersList();
    return;
  }

  await runShaderSearch();
}

async function runShaderSearch() {
  const token = ++shaderBrowseToken;
  const env = shaderTarget();

  shaderBrowseLoading = true;
  renderShadersList();

  const [result, installed] = await Promise.all([
    window.electronAPI.searchShaderpacks({ query: shaderQuery, gameVersion: env.gameVersion, loader: env.loader }),
    window.electronAPI.listShaders({ profileId: env.profileId, gameVersion: env.gameVersion })
  ]);
  if (token !== shaderBrowseToken) return;

  shaderBrowseLoading = false;
  shaderBrowseError = result?.success ? '' : (result?.message || 'Search failed.');
  browseShaders = result?.hits || [];
  shaderBrowseTotal = result?.total || 0;
  installedShaders = installed || [];
  renderShadersList();
}

/* ---------- actions ---------- */

function setShadersMode(mode) {
  shadersMode = SHADERS_MODES.includes(mode) ? mode : 'installed';
  localStorage.setItem('flash_shaders_mode', shadersMode);
  refreshShaders();
}

function filterShaders(text) {
  shaderQuery = text;
  clearTimeout(shaderFilterTimer);
  shaderFilterTimer = setTimeout(runShaderSearch, 350);
}

async function installShader(index) {
  const shader = browseShaders[index];
  if (!shader || shadersInstalling.has(shader.id)) return;

  const env = shaderTarget();
  shadersInstalling.add(shader.id);
  renderShadersList();

  const result = await window.electronAPI.installShader({
    profileId: env.profileId,
    projectId: shader.id,
    gameVersion: env.gameVersion,
    loader: env.loader
  });
  shadersInstalling.delete(shader.id);

  if (!result?.success) {
    showToast(result?.message || 'Install failed.', 'error');
    renderShadersList();
    return;
  }

  installedShaders = await window.electronAPI.listShaders({ profileId: env.profileId, gameVersion: env.gameVersion });
  renderShadersList();
  showToast(`${shader.title} installed.`, 'success');
}

async function setActiveShader(index) {
  const shader = installedShaders[index];
  if (!shader) return;

  const result = await window.electronAPI.setActiveShader({
    profileId: shaderTarget().profileId,
    filename: shader.filename
  });
  if (!result?.success) {
    showToast(result?.message || 'Could not activate that shaderpack.', 'error');
    return;
  }

  installedShaders = await window.electronAPI.listShaders({
    profileId: shaderTarget().profileId,
    gameVersion: shaderTarget().gameVersion
  });
  renderShadersList();
  showToast(`${shader.name} activated.`, 'success');
}

async function removeShader(index) {
  const shader = installedShaders[index];
  if (!shader) return;

  const result = await window.electronAPI.removeShader({
    profileId: shaderTarget().profileId,
    filename: shader.filename
  });
  if (!result?.success) {
    showToast(result?.message || 'Could not remove that shaderpack.', 'error');
    return;
  }

  installedShaders = await window.electronAPI.listShaders({
    profileId: shaderTarget().profileId,
    gameVersion: shaderTarget().gameVersion
  });
  renderShadersList();
  showToast(`${shader.name} removed.`, 'info');
}

function openShadersFolder() {
  window.electronAPI?.openShadersFolder?.({ profileId: shaderTarget().profileId });
}