/* Profiles are the thing a player actually launches: a game version, a mod
   loader, a memory budget and its own mods folder. The header tiles, the Play
   screen and the Mods page all read the active profile from here. */

let PROFILES = [];
let ACTIVE_PROFILE_ID = null;
let PROFILE_VERSIONS = null;
let PROFILE_ERROR = '';
let inspectingProfileId = null;
let nameTimer = null;

function profileText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function loaderName(loader) {
  return { vanilla: 'Vanilla', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' }[loader] || loader;
}

function loaderTone(loader) {
  return {
    vanilla: 'bg-white/45',
    fabric: 'bg-[#5ec36a]',
    forge: 'bg-[#e0a35d]',
    neoforge: 'bg-[#a98bf5]'
  }[loader] || 'bg-white/45';
}

function activeProfile() {
  return PROFILES.find((p) => p.id === ACTIVE_PROFILE_ID) || PROFILES[0] || {
    id: '1.8.9',
    name: '1.8.9 PvP',
    gameVersion: '1.8.9',
    loader: 'forge',
    ram: 4,
    mods: 0,
    ready: false
  };
}

async function loadProfiles() {
  if (!window.electronAPI?.listProfiles) return;
  const result = await window.electronAPI.listProfiles();
  PROFILES = result?.profiles || [];
  ACTIVE_PROFILE_ID = result?.activeId || PROFILES[0]?.id || null;

  if (!inspectingProfileId || !PROFILES.some((p) => p.id === inspectingProfileId)) {
    inspectingProfileId = ACTIVE_PROFILE_ID;
  }

  renderProfileTiles();
  renderProfilesPage();
  if (typeof refreshPlayChrome === 'function') refreshPlayChrome();
}

/* ---------- header tiles ---------- */

function profileDot(profile) {
  return profile.ready ? loaderTone(profile.loader) : 'bg-transparent border border-white/35';
}

function renderProfileTiles() {
  const trigger = document.getElementById('env-tiles');
  const picker = document.getElementById('env-picker');
  if (!trigger || !picker) return;

  const active = PROFILES.find((p) => p.id === ACTIVE_PROFILE_ID) || PROFILES[0] || null;

  // One compact label instead of a row of chips: with several profiles the
  // chips all read as the same game version, and two copies look identical.
  trigger.innerHTML = active
    ? `<span class="env-dot ${profileDot(active)}"></span>
       <span class="truncate max-w-[150px]">${profileText(active.name || active.gameVersion)}</span>
       <svg class="w-2.5 h-2.5 shrink-0 text-white/35" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="6 9 12 15 18 9"></polyline></svg>`
    : '<span class="text-white/45">No version</span>';
  trigger.classList.toggle('is-active', Boolean(active));

  picker.innerHTML = PROFILES.map((profile) => {
    const isActive = profile.id === ACTIVE_PROFILE_ID;
    const meta = `${loaderName(profile.loader)} · ${profile.gameVersion}${profile.ready ? '' : ' · setup needed'}`;
    return `
      <button type="button" onclick="selectProfile('${profile.id}')"
              class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors cursor-pointer ${isActive ? 'bg-white/[0.07]' : 'hover:bg-white/[0.05]'}">
        <span class="env-dot ${profileDot(profile)}"></span>
        <span class="min-w-0 flex-1">
          <span class="block text-[12px] font-medium text-white/90 truncate">${profileText(profile.name || profile.gameVersion)}</span>
          <span class="block text-[10px] text-white/40 truncate">${meta}</span>
        </span>
        ${isActive ? '<svg class="w-3.5 h-3.5 text-[#5ec36a] shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><polyline points="20 6 9 17 4 12"></polyline></svg>' : ''}
      </button>`;
  }).join('') + `
      <div class="h-px bg-white/[0.07] my-1"></div>
      <button type="button" onclick="switchTab('profiles'); closeEnvPicker()"
              class="w-full text-left px-2.5 py-2 rounded-lg hover:bg-white/[0.05] text-[12px] font-medium text-white/70 hover:text-white cursor-pointer">Manage versions</button>`;

  trigger.classList.toggle('hidden', PROFILES.length === 0);
}

function toggleEnvPicker(force) {
  const picker = document.getElementById('env-picker');
  const trigger = document.getElementById('env-tiles');
  if (!picker) return;

  const open = typeof force === 'boolean' ? force : picker.classList.contains('hidden');
  picker.classList.toggle('hidden', !open);
  trigger?.setAttribute('aria-expanded', String(open));
}

function closeEnvPicker() {
  toggleEnvPicker(false);
}

document.addEventListener('click', (e) => {
  const picker = document.getElementById('env-picker');
  const trigger = document.getElementById('env-tiles');
  if (!picker || picker.classList.contains('hidden')) return;
  if (!picker.contains(e.target) && !trigger?.contains(e.target)) closeEnvPicker();
});

async function selectProfile(id) {
  if (!id || id === ACTIVE_PROFILE_ID) return;

  const result = await window.electronAPI?.setActiveProfile?.(id);
  if (!result?.success) return;

  ACTIVE_PROFILE_ID = id;
  inspectingProfileId = id;
  renderProfileTiles();
  renderProfilesPage();
  closeEnvPicker();
  if (typeof refreshPlayChrome === 'function') refreshPlayChrome();

  const modsView = document.getElementById('mods-view');
  if (typeof refreshMods === 'function' && modsView && !modsView.classList.contains('hidden')) refreshMods();

  // The cosmetics tab edits the profile's own config file, so it has to follow
  // the active profile instead of saving into the one it was opened with.
  const cosmeticsView = document.getElementById('cosmetics-view');
  if (typeof loadCosmetics === 'function' && cosmeticsView && !cosmeticsView.classList.contains('hidden')) loadCosmetics();
}

/* ---------- profiles page ---------- */

async function ensureProfileVersions() {
  if (PROFILE_VERSIONS || !window.electronAPI?.remoteVersions) return;
  const result = await window.electronAPI.remoteVersions();
  PROFILE_ERROR = result?.success ? '' : (result?.message || 'Could not reach Mojang.');
  PROFILE_VERSIONS = result?.versions || [];
  if (!document.getElementById('profiles-view')?.classList.contains('hidden')) renderProfilesPage();
}

function profileRow(profile) {
  const active = profile.id === ACTIVE_PROFILE_ID;
  const inspecting = profile.id === inspectingProfileId;
  const running = typeof INSTANCES !== 'undefined'
    && (INSTANCES.sessions || []).some((s) => s.profileId === profile.id);

  return `
    <button type="button" onclick="inspectProfile('${profile.id}')"
            class="w-full text-left px-3 py-2.5 rounded-lg border transition-colors cursor-pointer ${inspecting ? 'bg-white/[0.07] border-white/20' : 'bg-white/[0.025] border-white/[0.07] hover:bg-white/[0.05] hover:border-white/15'}">
      <div class="flex items-center gap-2">
        <span class="w-1.5 h-1.5 rounded-full ${running ? 'bg-[#4cbb5e]' : profile.ready ? loaderTone(profile.loader) : 'bg-transparent border border-white/30'}"></span>
        <span class="text-[12px] font-semibold text-white truncate flex-1">${profileText(profile.name)}</span>
        ${running ? '<span class="text-[10px] font-mono text-[#7fe08d]">running</span>' : ''}
        ${active && !running ? '<span class="text-[10px] font-mono text-white/35">active</span>' : ''}
      </div>
      <p class="text-[11px] font-mono text-white/35 mt-1.5">${profileText(profile.gameVersion)} · ${loaderName(profile.loader)}</p>
      <p class="text-[11px] text-white/30 mt-0.5">${profile.mods ? `${profile.mods} mod${profile.mods === 1 ? '' : 's'}` : 'No mods'}${profile.ready ? '' : ' · not downloaded'}${profile.minecraftDir ? ' · imported' : ''}</p>
    </button>`;
}

function versionOptions(profile) {
  const releases = (PROFILE_VERSIONS || []).filter((v) => v.type === 'release');
  const list = releases.length ? releases : (PROFILE_VERSIONS || []);
  const known = list.some((v) => v.id === profile.gameVersion);

  const options = (known ? list : [{ id: profile.gameVersion }, ...list])
    .map((v) => `<option value="${profileText(v.id)}" ${v.id === profile.gameVersion ? 'selected' : ''}>${profileText(v.id)}</option>`)
    .join('');

  return `<select id="profile-version" onchange="saveProfileField('gameVersion', this.value)"
    class="h-8 w-full bg-[#121317] border border-white/10 focus:border-white/25 rounded-md px-2 text-[12px] font-mono text-white focus:outline-none cursor-pointer">
    ${options}
  </select>`;
}

function loaderButton(profile, loader, label) {
  const active = profile.loader === loader;
  return `<button type="button" onclick="saveProfileField('loader', '${loader}')"
    class="h-7 px-2 rounded text-[11px] font-medium transition-colors cursor-pointer ${active ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white hover:bg-white/[0.05]'}">${label}</button>`;
}

function ramButton(profile, gb) {
  const active = profile.ram === gb;
  return `<button type="button" onclick="saveProfileField('ram', ${gb})"
    class="h-7 rounded font-mono text-[11px] border transition-colors cursor-pointer ${active ? 'bg-white/[0.1] border-white/25 text-white' : 'bg-transparent border-white/10 text-white/45 hover:text-white hover:border-white/20'}">${gb} GB</button>`;
}

function profileDetail(profile) {
  const running = typeof INSTANCES !== 'undefined'
    && (INSTANCES.sessions || []).some((s) => s.profileId === profile.id);

  return `
    <div class="flex items-start justify-between gap-3 pb-4 border-b border-white/[0.07]">
      <div class="min-w-0 flex-1">
        <label class="block text-[11px] text-white/35 mb-1">Name</label>
        <input id="profile-name" value="${profileText(profile.name)}" maxlength="40"
               oninput="queueProfileName(this.value)"
               class="w-full h-8 bg-[#121317] border border-white/10 focus:border-white/25 rounded-md px-2 text-[12px] text-white focus:outline-none transition-colors" />
      </div>
      <div class="shrink-0 pt-[18px] flex items-center gap-2">
        <!-- Starting this profile must not switch the active one first; several
             profiles can run at the same time. -->
        <button type="button" onclick="launchProfileFromList('${profile.id}')" ${running ? 'disabled' : ''}
                class="h-8 px-3 rounded-md bg-[#4cbb5e]/15 hover:bg-[#4cbb5e]/25 disabled:opacity-40 disabled:hover:bg-[#4cbb5e]/15 border border-[#4cbb5e]/30 text-[11px] font-semibold text-[#7fe08d] transition-colors cursor-pointer disabled:cursor-default">
          ${running ? 'Running' : 'Launch'}
        </button>
        <button type="button" onclick="selectProfile('${profile.id}')" ${profile.id === ACTIVE_PROFILE_ID ? 'disabled' : ''}
                class="h-8 px-3 rounded-md bg-white hover:bg-white/90 disabled:bg-white/[0.06] disabled:text-white/35 text-[#0b0b0e] text-[11px] font-semibold transition-colors cursor-pointer disabled:cursor-default">
          ${profile.id === ACTIVE_PROFILE_ID ? 'Active' : 'Use profile'}
        </button>
        <button type="button" onclick="deleteProfileConfirm()" aria-label="Delete profile"
                class="h-8 px-2 rounded-md text-[11px] font-medium text-white/35 hover:text-[#ef8b8b] hover:bg-[#e04f4f]/12 transition-colors cursor-pointer">
          Delete
        </button>
      </div>
    </div>

    <div class="grid grid-cols-2 gap-4 pt-4">
      <div>
        <label class="block text-[11px] text-white/35 mb-1">Game version</label>
        ${profile.minecraftDir ? `
          <div class="h-8 px-2 flex items-center rounded-md bg-white/[0.03] border border-white/[0.07] text-[12px] font-mono text-white/70 truncate" title="${profileText(profile.sourceVersion || profile.gameVersion)}">
            ${profileText(profile.sourceVersion || profile.gameVersion)}
          </div>
          <p class="text-[11px] text-white/30 mt-1.5">Imported · version and loader stay fixed</p>
        ` : `
          ${versionOptions(profile)}
          <p class="text-[11px] text-white/30 mt-1.5">${PROFILE_ERROR || (PROFILE_VERSIONS ? `${PROFILE_VERSIONS.length} versions from Mojang` : 'Loading Mojang versions…')}</p>
        `}
      </div>
      <div>
        <label class="block text-[11px] text-white/35 mb-1">Loader</label>
        ${profile.minecraftDir ? `
          <div class="h-8 px-2 flex items-center rounded-md bg-white/[0.03] border border-white/[0.07] text-[12px] text-white/70 truncate" title="${profileText(`${loaderName(profile.loader)} ${profile.loaderVersion || ''}`.trim())}">
            ${profileText(`${loaderName(profile.loader)}${profile.loaderVersion ? ` ${profile.loaderVersion}` : ''}`)}
          </div>
          <p class="text-[11px] text-white/30 mt-1.5">${profile.loader === 'vanilla' ? 'Runs the files already in this folder' : 'The installed loader is reused, nothing re-downloads'}</p>
        ` : `
          <div class="flex gap-0.5 bg-white/[0.04] p-0.5 rounded-md">
            ${loaderButton(profile, 'vanilla', 'Vanilla')}
            ${loaderButton(profile, 'fabric', 'Fabric')}
            ${loaderButton(profile, 'forge', 'Forge')}
            ${loaderButton(profile, 'neoforge', 'NeoForge')}
          </div>
          <p class="text-[11px] text-white/30 mt-1.5">Installed with the game on first launch.</p>
        `}
      </div>

      <div>
        <label class="block text-[11px] text-white/35 mb-1">Memory</label>
        <div class="grid grid-cols-4 gap-1">
          ${[2, 4, 6, 8].map((gb) => ramButton(profile, gb)).join('')}
        </div>
      </div>

      <div>
        <label class="block text-[11px] text-white/35 mb-1">Java</label>
        <div class="flex items-center gap-1.5">
          <span class="flex-1 h-8 px-2 rounded-md bg-white/[0.03] border border-white/[0.07] text-[11px] text-white/55 flex items-center truncate" id="profile-java-label">
            ${profile.javaPath ? 'Custom path' : 'Automatic'}
          </span>
          <button type="button" onclick="chooseProfileJava()" class="h-8 px-2 rounded-md bg-white/[0.06] hover:bg-white/[0.1] text-[11px] text-white/70 transition-colors cursor-pointer">Pick</button>
          ${profile.javaPath ? '<button type="button" onclick="saveProfileField(\'javaPath\', \'\')" class="h-8 px-2 rounded-md bg-white/[0.06] hover:bg-white/[0.1] text-[11px] text-white/70 transition-colors cursor-pointer">Auto</button>' : ''}
        </div>
      </div>
    </div>

    <div class="flex items-center justify-between gap-3 pt-4 mt-4 border-t border-white/[0.07]">
      <div class="min-w-0">
        <p class="text-[11px] text-white/30 truncate" title="${profileText(profile.minecraftDir || `instances/${profile.id}`)}">
          Found at <span class="font-mono">${profileText(profile.minecraftDir || `instances/${profile.id}`)}</span>
        </p>
        ${profile.runtimeDir && profile.runtimeDir !== profile.minecraftDir ? `
          <p class="text-[10px] font-mono text-white/20 truncate mt-0.5" title="${profileText(profile.runtimeDir)}">
            Game files from <span>${profileText(profile.runtimeDir)}</span>
          </p>` : ''}
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <button type="button" onclick="window.electronAPI?.openProfileFolder?.('${profile.id}')"
                class="h-7 px-2.5 rounded-md bg-white/[0.06] hover:bg-white/[0.1] text-[11px] font-medium text-white/70 transition-colors cursor-pointer">Open folder</button>
        <button type="button" onclick="switchTab('mods')"
                class="h-7 px-2.5 rounded-md bg-white/[0.06] hover:bg-white/[0.1] text-[11px] font-medium text-white/70 transition-colors cursor-pointer">Mods</button>
      </div>
    </div>`;
}

function renderProfilesPage() {
  const list = document.getElementById('profiles-list');
  const detail = document.getElementById('profile-detail');
  if (!list || !detail) return;

  list.innerHTML = PROFILES.map(profileRow).join('');
  const selected = PROFILES.find((p) => p.id === inspectingProfileId) || PROFILES[0];
  detail.innerHTML = selected ? profileDetail(selected) : '';

  const subtitle = document.getElementById('profiles-subtitle');
  if (subtitle) {
    subtitle.textContent = PROFILES.length
      ? `${PROFILES.length} profile${PROFILES.length === 1 ? '' : 's'} · ${activeProfile().name} is active`
      : 'No profiles yet';
  }
}

function inspectProfile(id) {
  inspectingProfileId = id;
  renderProfilesPage();
  if (!PROFILE_VERSIONS) ensureProfileVersions();
}

/* ---------- editing ---------- */

function queueProfileName(value) {
  clearTimeout(nameTimer);
  nameTimer = setTimeout(() => saveProfileField('name', value), 400);
}

async function saveProfileField(field, value) {
  const profile = PROFILES.find((p) => p.id === inspectingProfileId);
  if (!profile) return;

  const result = await window.electronAPI?.updateProfile?.({ id: profile.id, [field]: value });
  if (!result?.success) {
    showToast(result?.message || 'Could not save that profile.', 'error');
    return;
  }

  PROFILES = PROFILES.map((p) => (p.id === result.profile.id ? { ...p, ...result.profile } : p));
  renderProfileTiles();
  renderProfilesPage();
  if (typeof refreshPlayChrome === 'function') refreshPlayChrome();
}

let deleteArmed = null;

function deleteProfileConfirm() {
  const profile = PROFILES.find((p) => p.id === inspectingProfileId);
  if (!profile) return;

  if (deleteArmed !== profile.id) {
    deleteArmed = profile.id;
    showToast(`Press Delete again to remove ${profile.name}. Its folder stays on disk.`, 'info');
    setTimeout(() => { if (deleteArmed === profile.id) deleteArmed = null; }, 5000);
    return;
  }

  deleteArmed = null;
  removeProfile(profile.id);
}

async function removeProfile(id) {
  const result = await window.electronAPI?.deleteProfile?.(id);
  if (!result?.success) {
    showToast(result?.message || 'Could not delete that profile.', 'error');
    return;
  }

  PROFILES = PROFILES.filter((p) => p.id !== id);
  ACTIVE_PROFILE_ID = result.activeId;
  inspectingProfileId = ACTIVE_PROFILE_ID;
  renderProfileTiles();
  renderProfilesPage();
  if (typeof refreshPlayChrome === 'function') refreshPlayChrome();
  showToast('Profile removed.', 'info');
}

/* ---------- new profile ---------- */

let NEW_PROFILE_LOADER = null;

function newLoaderButton(loader) {
  const active = NEW_PROFILE_LOADER === loader;
  return `<button type="button" onclick="setNewProfileLoader('${loader}')"
    class="h-7 px-2 rounded text-[11px] font-medium transition-colors cursor-pointer ${active ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white hover:bg-white/[0.05]'}">${loaderName(loader)}</button>`;
}

function renderNewProfileLoaders() {
  const wrap = document.getElementById('np-loaders');
  if (!wrap) return;
  wrap.innerHTML = ['vanilla', 'fabric', 'forge', 'neoforge'].map(newLoaderButton).join('');
}

function setNewProfileLoader(loader) {
  NEW_PROFILE_LOADER = loader;
  renderNewProfileLoaders();
}

function fillNewProfileVersions() {
  const select = document.getElementById('np-version');
  const note = document.getElementById('np-version-note');
  if (!select) return;

  const releases = (PROFILE_VERSIONS || []).filter((v) => v.type === 'release');
  const list = releases.length ? releases : (PROFILE_VERSIONS || []);
  const fallback = activeProfile().gameVersion;

  if (!list.length) {
    select.innerHTML = `<option value="${profileText(fallback)}">${profileText(fallback)}</option>`;
    if (note) note.textContent = PROFILE_ERROR || 'Using your active profile version.';
    return;
  }

  const picked = list.some((v) => v.id === fallback) ? fallback : list[0].id;
  select.innerHTML = list
    .map((v) => `<option value="${profileText(v.id)}" ${v.id === picked ? 'selected' : ''}>${profileText(v.id)}</option>`)
    .join('');
  if (note) note.textContent = `${list.length} versions from Mojang`;
}

async function openNewProfileModal() {
  const modal = document.getElementById('new-profile-modal');
  if (!modal) return;

  NEW_PROFILE_LOADER = activeProfile().loader || 'vanilla';
  renderNewProfileLoaders();

  const name = document.getElementById('np-name');
  if (name) name.value = '';

  fillNewProfileVersions();
  modal.classList.remove('hidden');
  modal.classList.add('flex');

  await ensureProfileVersions();
  fillNewProfileVersions();
  document.getElementById('np-name')?.focus();
}

function closeNewProfileModal() {
  const modal = document.getElementById('new-profile-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

async function createProfile(event) {
  event?.preventDefault?.();

  const button = document.getElementById('np-submit');
  const gameVersion = document.getElementById('np-version')?.value;
  if (!gameVersion || !window.electronAPI?.createProfile) return;

  const loader = NEW_PROFILE_LOADER || 'vanilla';
  const typed = (document.getElementById('np-name')?.value || '').trim();
  const name = typed || `${gameVersion} ${loaderName(loader)}`;

  if (button) {
    button.disabled = true;
    button.textContent = 'Creating…';
  }

  const result = await window.electronAPI.createProfile({
    name,
    gameVersion,
    loader,
    ram: activeProfile().ram
  });

  if (button) {
    button.disabled = false;
    button.textContent = 'Create profile';
  }

  if (!result?.success) {
    showToast(result?.message || 'Could not create a profile.', 'error');
    return;
  }

  closeNewProfileModal();
  PROFILES.push(result.profile);
  inspectingProfileId = result.profile.id;
  renderProfileTiles();
  renderProfilesPage();
  if (typeof refreshPlayChrome === 'function') refreshPlayChrome();
  showToast(
    loader === 'vanilla' ? 'Profile created.' : 'Profile created. Adding performance mods…',
    'success'
  );
}

async function chooseProfileJava() {
  const picked = await window.electronAPI?.pickJava?.();
  if (!picked?.success) return;
  saveProfileField('javaPath', picked.path);
}

/* ---------- importing an existing .minecraft ---------- */

let IMPORT_SCAN = null;
let IMPORT_ERROR = '';
let IMPORT_RUNTIME = '';
const IMPORT_SELECTED = new Set();

async function openImportModal() {
  const modal = document.getElementById('import-modal');
  if (!modal) return;

  modal.classList.remove('hidden');
  modal.classList.add('flex');
  await scanMinecraftFolder();
}

async function browseMinecraftFolder() {
  const picked = await window.electronAPI?.minecraftPick?.();
  if (!picked?.success || !picked.path) return;
  await scanMinecraftFolder(picked.path);
}

async function scanMinecraftFolder(root) {
  IMPORT_SCAN = null;
  IMPORT_ERROR = '';
  IMPORT_RUNTIME = '';
  IMPORT_SELECTED.clear();

  const rootLabel = document.getElementById('import-root');
  const list = document.getElementById('import-list');
  if (rootLabel) rootLabel.textContent = 'Looking for an existing Minecraft folder…';
  if (list) list.innerHTML = '<p class="px-2 py-6 text-center text-[11px] text-white/30">Scanning this PC…</p>';
  updateImportCount();

  let result = null;
  try {
    result = await window.electronAPI?.minecraftScan?.(root);
  } catch (err) {
    result = null;
  }

  if (!result) {
    IMPORT_ERROR = 'Could not read any Minecraft folder on this PC.';
  } else if (!result.success) {
    IMPORT_ERROR = result.message || 'No .minecraft folder found.';
    if (rootLabel) rootLabel.textContent = result.root || root || '';
  } else {
    IMPORT_SCAN = result;
    if (rootLabel) rootLabel.textContent = result.root;
    if (result.runtime && result.runtime !== result.root) IMPORT_RUNTIME = result.runtime;
    for (const version of result.versions) {
      if (version.supported && !version.imported && version.suggested !== false) IMPORT_SELECTED.add(version.id);
    }
  }

  renderImportList();
  updateImportCount();
}

function closeImportModal() {
  const modal = document.getElementById('import-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

function importRow(version) {
  const imported = Boolean(version.imported);
  const blocked = !version.supported || imported;
  const selected = !blocked && IMPORT_SELECTED.has(version.id);

  const meta = [version.gameVersion, loaderName(version.loader)];
  if (version.loaderVersion) meta.push(version.loaderVersion);
  if (!version.supported) meta.push('unsupported');
  else if (imported) meta.push('already imported');
  else if (!version.jar) meta.push('jar downloads on first launch');

  return `
    <button type="button" data-import-id="${profileText(version.id)}" onclick="toggleImportVersion(this.dataset.importId)" ${blocked ? 'disabled' : ''}
            class="w-full text-left flex items-center gap-3 px-2.5 py-2 rounded-lg border transition-colors ${blocked
              ? 'border-transparent bg-transparent opacity-40 cursor-default'
              : selected
                ? 'bg-white/[0.08] border-white/25 cursor-pointer'
                : 'bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.05] hover:border-white/15 cursor-pointer'}">
      <span class="w-3.5 h-3.5 rounded-[4px] border flex items-center justify-center shrink-0 ${selected ? 'bg-white border-white' : 'border-white/25'}">
        ${selected ? '<svg class="w-2.5 h-2.5 text-[#0b0b0e]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4"><polyline points="20 6 9 17 4 12"></polyline></svg>' : ''}
      </span>
      <span class="min-w-0 flex-1">
        <span class="block text-[12px] font-semibold text-white truncate">${profileText(version.id)}</span>
        <span class="block text-[11px] font-mono text-white/35 mt-0.5 truncate">${profileText(meta.filter(Boolean).join(' · '))}</span>
      </span>
    </button>`;
}

function renderImportList() {
  const list = document.getElementById('import-list');
  if (!list) return;

  if (IMPORT_ERROR) {
    list.innerHTML = `<p class="px-2 py-8 text-center text-[11px] text-white/35">${profileText(IMPORT_ERROR)}</p>`;
    return;
  }
  if (!IMPORT_SCAN) {
    list.innerHTML = '<p class="px-2 py-6 text-center text-[11px] text-white/30">Scanning this PC…</p>';
    return;
  }
  if (!IMPORT_SCAN.versions.length) {
    list.innerHTML = '<p class="px-2 py-8 text-center text-[11px] text-white/35">No versions found in that folder.</p>';
    return;
  }

  const usable = IMPORT_SCAN.versions.filter((v) => v.supported && !v.imported).length;
  const rows = IMPORT_SCAN.versions.map(importRow).join('');
  const runtimeLine = IMPORT_RUNTIME
    ? `<p class="px-2 pb-2 text-[10px] font-mono text-white/25 truncate" title="${profileText(IMPORT_RUNTIME)}">Game files from ${profileText(IMPORT_RUNTIME)}</p>`
    : '';
  list.innerHTML = `
    <p class="px-2 pt-1 pb-2 text-[11px] text-white/35">${usable} version${usable === 1 ? '' : 's'} ready to import</p>
    ${runtimeLine}
    <div class="flex flex-col gap-1">${rows}</div>`;
}

function toggleImportVersion(id) {
  const version = IMPORT_SCAN?.versions.find((v) => v.id === id);
  if (!version || !version.supported || version.imported) return;

  if (IMPORT_SELECTED.has(id)) IMPORT_SELECTED.delete(id);
  else IMPORT_SELECTED.add(id);

  renderImportList();
  updateImportCount();
}

function updateImportCount() {
  const button = document.getElementById('import-run');
  if (!button) return;

  const busy = button.dataset.busy === '1';
  const count = IMPORT_SELECTED.size;
  button.disabled = busy || count === 0;
  button.textContent = busy ? 'Importing…' : count ? `Import ${count} selected` : 'Import selected';
}

async function runImport() {
  if (!IMPORT_SCAN || !IMPORT_SELECTED.size) return;

  const button = document.getElementById('import-run');
  const note = document.getElementById('import-note');
  const noteText = note?.textContent;
  const versions = [...IMPORT_SELECTED];

  if (button) {
    button.dataset.busy = '1';
    updateImportCount();
  }
  if (note) note.textContent = `Linking ${versions.length} version${versions.length === 1 ? '' : 's'} to your existing files…`;

  let result = null;
  try {
    result = await window.electronAPI?.minecraftImport?.({ root: IMPORT_SCAN.root, versions });
  } catch (err) {
    result = null;
  }

  if (button) {
    delete button.dataset.busy;
    updateImportCount();
  }
  if (note) note.textContent = noteText;

  if (!result?.success) {
    showToast(result?.message || 'Could not import those versions.', 'error');
    return;
  }

  const created = result.profiles || [];
  for (const profile of created) {
    if (!PROFILES.some((p) => p.id === profile.id)) PROFILES.push(profile);
  }

  if (!created.length) {
    showToast('Those versions are already in your profiles.', 'info');
    return;
  }

  inspectingProfileId = created[0].id;
  renderProfileTiles();
  renderProfilesPage();
  if (typeof refreshPlayChrome === 'function') refreshPlayChrome();
  closeImportModal();
  showToast(created.length === 1 ? 'Imported 1 profile.' : `Imported ${created.length} profiles.`, 'success');
}

/* ---------- performance mods on new profiles ---------- */

function handleProfileSetup(patch) {
  if (!patch) return;

  const note = document.getElementById('profile-setup-note');
  const text = document.getElementById('profile-setup-text');
  const hide = () => {
    note?.classList.add('hidden');
    note?.classList.remove('flex');
  };

  if (patch.phase === 'done') {
    hide();
    const count = patch.installed?.length || 0;
    showToast(
      count ? `Added ${count} performance mod${count === 1 ? '' : 's'}.` : 'No performance mods matched this version.',
      count ? 'success' : 'info'
    );
    loadProfiles();
    const modsView = document.getElementById('mods-view');
    if (typeof refreshMods === 'function' && modsView && !modsView.classList.contains('hidden')) refreshMods();
    return;
  }

  if (patch.phase === 'error') {
    hide();
    showToast(patch.message || 'Could not add performance mods.', 'error');
    return;
  }

  if (!note || !text) return;
  note.classList.remove('hidden');
  note.classList.add('flex');

  if (patch.phase === 'start') {
    text.textContent = `Adding performance mods for ${patch.gameVersion || 'this profile'} · ${loaderName(patch.loader)}`;
  } else if (patch.phase === 'perf') {
    const pct = patch.total ? Math.round((patch.done / patch.total) * 100) : 0;
    text.textContent = `${patch.message || 'Checking mods'} · ${pct}%`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  renderProfileTiles();
  window.electronAPI?.onProfileSetup?.(handleProfileSetup);

  /* "Launch" and "Running" on a profile row follow the live process list, so
     the page repaints when a game starts or stops. */
  window.electronAPI?.onInstancesChanged?.(() => {
    if (!document.getElementById('profiles-view')?.classList.contains('hidden')) renderProfilesPage();
  });
});
