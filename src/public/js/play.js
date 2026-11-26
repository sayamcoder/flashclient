/* The Play screen launches whatever profile is active. The version pill, the
   memory chips and the quick-join target all read from the profile store, and
   the launch button mirrors the real game process instead of a timer. */

const RAM_CHOICES = [2, 4, 6, 8];
const PHASE_TITLES = {
  java: 'Setting up Java',
  loader: 'Installing the loader',
  client: 'Downloading Minecraft',
  libraries: 'Downloading libraries',
  assets: 'Downloading assets',
  done: 'Starting Minecraft'
};

let launchPhase = 'idle';
let lastGameLines = [];
let downloadState = null;
let speedMark = null;

/* Java is the built-in path. Rust hands off to Horizon, which owns its own
   launcher, account and worlds — Flash Client only finds the exe and opens it. */
let playEdition = 'java';
let horizonState = { found: false, path: '' };
let rustLaunching = false;

function settingsSnapshot() {
  return typeof SETTINGS !== 'undefined' && SETTINGS ? SETTINGS : {};
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function activeProfileSafe() {
  if (typeof activeProfile === 'function') return activeProfile();
  return { id: '1.8.9', name: '1.8.9 PvP', gameVersion: '1.8.9', loader: 'forge', ram: 4 };
}

/* ---------- chrome ---------- */

/* Paint the edition switch and everything that changes with it. Called on
   load, after a settings round-trip, and whenever Horizon's path is re-checked. */
function renderEditionState() {
  const rust = playEdition === 'rust';
  const profile = activeProfileSafe();

  document.getElementById('edition-java')?.classList.toggle('is-active', !rust);
  document.getElementById('edition-rust')?.classList.toggle('is-active', rust);
  document.getElementById('edition-rust')?.classList.toggle('is-missing', !horizonState.found);

  const dot = document.getElementById('edition-rust-dot');
  if (dot) {
    dot.classList.toggle('is-ready', horizonState.found);
    dot.classList.toggle('is-missing', !horizonState.found);
  }

  const trigger = document.getElementById('version-trigger-btn');
  trigger?.classList.toggle('pointer-events-none', rust);
  trigger?.classList.toggle('opacity-50', rust);

  const quick = document.getElementById('quick-play-btn');
  quick?.classList.toggle('pointer-events-none', rust);
  quick?.classList.toggle('opacity-40', rust);

  const label = document.getElementById('active-version-label');
  if (label) label.textContent = rust ? 'Rust Edition' : profile.name;

  const sub = document.getElementById('active-version-sub');
  if (sub) sub.textContent = rust ? 'Horizon launcher' : `${profile.gameVersion} · ${loaderName(profile.loader)}`;
}

async function refreshHorizonState() {
  const result = await window.electronAPI?.horizonStatus?.();
  horizonState = { found: Boolean(result?.found), path: result?.path || '' };
  renderEditionState();
  setLaunchButton(launchPhase);
  updateStatusLine();
  return horizonState;
}

async function setPlayEdition(edition) {
  const next = edition === 'rust' ? 'rust' : 'java';
  if (next === playEdition) { renderEditionState(); return; }

  playEdition = next;
  toggleVersionFlyout(false);
  document.getElementById('quick-flyout')?.classList.add('hidden');
  renderEditionState();
  setLaunchButton(launchPhase);
  updateStatusLine();

  await window.electronAPI?.setSettings?.({ playEdition: next });

  if (next === 'rust') {
    showToast(
      horizonState.found
        ? 'Rust Edition selected. Play opens Horizon.'
        : 'Rust Edition needs Horizon. Press Play and Flash Client walks you through it.',
      'info'
    );
  } else {
    showToast('Java Edition selected.', 'info');
  }
}

function refreshPlayChrome() {
  const profile = activeProfileSafe();

  const label = document.getElementById('active-version-label');
  if (label) label.textContent = profile.name;

  const sub = document.getElementById('active-version-sub');
  if (sub) sub.textContent = `${profile.gameVersion} · ${loaderName(profile.loader)}`;

  if (typeof renderProfileTiles === 'function') renderProfileTiles();
  renderProfileOptions();
  renderRamOptions();
  renderEditionState();
  setLaunchButton(launchPhase);
  updateStatusLine();
}

/* ---------- profile flyout ---------- */

function renderProfileOptions() {
  const wrap = document.getElementById('env-options');
  if (!wrap || typeof PROFILES === 'undefined') return;

  if (!PROFILES.length) {
    wrap.innerHTML = '<p class="px-2.5 py-2 text-[11px] text-white/35">No profiles yet.</p>';
    return;
  }

  const current = activeProfileSafe().id;
  const rows = PROFILES.map((profile) => {
    const active = profile.id === current;
    return `
      <button type="button" onclick="pickProfile('${profile.id}')"
              class="w-full px-2.5 py-2 rounded-md text-left hover:bg-white/[0.06] flex items-center justify-between gap-2 cursor-pointer ${active ? 'bg-white/[0.05]' : ''}">
        <span class="flex flex-col leading-none min-w-0">
          <span class="text-[12px] font-medium truncate ${active ? 'text-white' : 'text-white/65'}">${profileText(profile.name)}</span>
          <span class="text-[11px] text-white/35 mt-1.5">${profileText(profile.gameVersion)} · ${loaderName(profile.loader)}</span>
        </span>
        ${active ? '<svg class="w-3.5 h-3.5 text-white/70 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>' : ''}
      </button>`;
  }).join('');

  wrap.innerHTML = `${rows}
    <div class="h-px bg-white/[0.07] my-1"></div>
    <button type="button" onclick="switchTab('profiles'); toggleVersionFlyout(false)"
            class="w-full px-2.5 py-2 rounded-md text-left hover:bg-white/[0.06] text-[11px] font-medium text-white/45 hover:text-white transition-colors cursor-pointer">
      Manage profiles
    </button>`;
}

async function pickProfile(id) {
  toggleVersionFlyout(false);
  if (typeof selectProfile === 'function') await selectProfile(id);
}

function renderRamOptions() {
  const wrap = document.getElementById('ram-options');
  if (!wrap) return;

  const profile = activeProfileSafe();
  wrap.innerHTML = RAM_CHOICES.map((gb) => {
    const active = gb === profile.ram;
    return `
      <button type="button" onclick="setRam(${gb})"
              class="h-8 rounded-md text-[12px] font-mono border transition-colors cursor-pointer ${active ? 'bg-white/[0.1] border-white/25 text-white' : 'bg-transparent border-white/10 text-white/45 hover:text-white hover:border-white/20'}">
        ${gb} GB
      </button>`;
  }).join('');
}

async function setRam(gb) {
  const profile = activeProfileSafe();
  const result = await window.electronAPI?.updateProfile?.({ id: profile.id, ram: gb });
  if (!result?.success) {
    showToast(result?.message || 'Could not change memory.', 'error');
    return;
  }

  if (typeof PROFILES !== 'undefined') {
    PROFILES = PROFILES.map((p) => (p.id === result.profile.id ? { ...p, ...result.profile } : p));
  }
  renderRamOptions();
  if (typeof renderProfileTiles === 'function') renderProfileTiles();
  updateStatusLine();
}

function toggleVersionFlyout(force) {
  const flyout = document.getElementById('version-flyout');
  if (!flyout) return;
  document.getElementById('quick-flyout')?.classList.add('hidden');

  const willOpen = typeof force === 'boolean' ? force : flyout.classList.contains('hidden');
  if (willOpen) {
    toggleNewsSheet(false);
    renderProfileOptions();
    renderRamOptions();
  }
  flyout.classList.toggle('hidden', !willOpen);
}

/* ---------- quick play ---------- */

function toggleQuickFlyout(event) {
  event?.stopPropagation();
  const flyout = document.getElementById('quick-flyout');
  document.getElementById('version-flyout')?.classList.add('hidden');
  if (!flyout) return;

  if (flyout.classList.contains('hidden')) {
    toggleNewsSheet(false);
    renderQuickOptions();
    flyout.classList.remove('hidden');
  } else {
    flyout.classList.add('hidden');
  }
}

function renderQuickOptions() {
  const wrap = document.getElementById('quick-server-options');
  if (!wrap || typeof serversList === 'undefined') return;

  const saved = localStorage.getItem('flash_quick_server');

  wrap.innerHTML = serversList.map((server) => {
    const active = server.ip === saved;
    return `
      <button type="button" data-ip="${escapeHtml(server.ip)}" data-name="${escapeHtml(server.name)}" onclick="setQuickServer(this.dataset.ip, this.dataset.name)"
              class="w-full px-2.5 py-2 rounded-md text-left hover:bg-white/[0.06] flex items-center justify-between gap-2 cursor-pointer ${active ? 'bg-white/[0.05]' : ''}">
        <span class="flex flex-col leading-none min-w-0">
          <span class="text-[12px] font-medium truncate ${active ? 'text-white' : 'text-white/65'}">${escapeHtml(server.name)}</span>
          <span class="text-[11px] font-mono text-white/35 mt-1.5">${escapeHtml(server.ip)}</span>
        </span>
        <span class="text-[11px] font-mono text-white/40 shrink-0">${escapeHtml(typeof liveCountLabel === 'function' ? liveCountLabel(server) : '—')}</span>
      </button>`;
  }).join('');
}

function setQuickServer(ip, name) {
  localStorage.setItem('flash_quick_server', ip);
  document.getElementById('quick-flyout')?.classList.add('hidden');
  showToast(`${name} is the quick play server now.`, 'success');
  updateStatusLine();
}

function quickTarget() {
  const saved = localStorage.getItem('flash_quick_server');
  if (typeof serversList === 'undefined') return null;
  return serversList.find((s) => s.ip === saved) || serversList[0];
}

function splitHost(ip) {
  const value = String(ip || '').trim();
  const match = value.match(/^([^:]+):(\d{2,5})$/);
  if (!match) return { host: value, port: null };
  return { host: match[1], port: Number(match[2]) };
}

function quickPlay() {
  if (launchPhase !== 'idle') {
    showToast(launchPhase === 'running' ? 'Minecraft is already running.' : 'Minecraft is still starting.', 'info');
    return;
  }

  const target = quickTarget();
  if (!target) {
    showToast('Add a server in the Servers tab first.', 'error');
    switchTab('servers');
    return;
  }

  const { host, port } = splitHost(target.ip);
  launch({ host, port, label: target.name });
}

/* ---------- multi-instance awareness ---------- */

function instanceCountLabel() {
  const count = typeof INSTANCES !== 'undefined' ? (INSTANCES.sessions || []).length : 0;
  if (!count) return '';
  return count === 1 ? '1 instance running' : `${count} instances running`;
}

/* ---------- download overlay ---------- */

function showDownloadOverlay() {
  const overlay = document.getElementById('download-overlay');
  if (!overlay) return;

  downloadState = null;
  speedMark = null;
  document.getElementById('download-phase').textContent = 'Preparing';
  document.getElementById('download-message').textContent = 'Checking files…';
  document.getElementById('download-percent').textContent = '0%';
  document.getElementById('download-bytes').textContent = '';
  document.getElementById('download-bar').style.width = '0%';
  overlay.classList.remove('hidden');
  overlay.classList.add('flex');

  if (typeof MiniGame !== 'undefined') MiniGame.start(settingsSnapshot().minigame !== false);
}

function hideDownloadOverlay() {
  const overlay = document.getElementById('download-overlay');
  overlay?.classList.add('hidden');
  overlay?.classList.remove('flex');
  if (typeof MiniGame !== 'undefined') MiniGame.stop();
}

function handleLaunchProgress(patch) {
  if (!patch) return;
  downloadState = { ...downloadState, ...patch };

  const title = PHASE_TITLES[patch.phase] || 'Preparing';
  const overall = Math.max(0, Math.min(1, patch.overall ?? patch.ratio ?? 0));

  document.getElementById('download-phase').textContent = title;
  document.getElementById('download-message').textContent = patch.message || '';
  document.getElementById('download-percent').textContent = `${Math.round(overall * 100)}%`;
  document.getElementById('download-bar').style.width = `${Math.max(1, overall * 100)}%`;

  const bytesEl = document.getElementById('download-bytes');
  if (patch.phase === 'done') {
    if (bytesEl) bytesEl.textContent = 'Java ready';
    updateStatusLine();
    return;
  }
  if (!patch.bytes) {
    if (bytesEl) bytesEl.textContent = '';
    updateStatusLine();
    return;
  }

  // Byte counts reset between phases, so the speed estimate does too.
  const now = Date.now();
  if (!speedMark || speedMark.phase !== patch.phase) {
    speedMark = { phase: patch.phase, bytes: patch.bytes, at: now, speed: 0 };
  } else if (now - speedMark.at >= 600) {
    speedMark.speed = (patch.bytes - speedMark.bytes) / ((now - speedMark.at) / 1000);
    speedMark.bytes = patch.bytes;
    speedMark.at = now;
  }

  if (bytesEl) {
    const speed = speedMark.speed > 0 ? ` · ${formatBytes(speedMark.speed)}/s` : '';
    bytesEl.textContent = `${formatBytes(patch.bytes)}${speed}`;
  }

  updateStatusLine();
}

/* ---------- launch ---------- */

function setLaunchButton(mode) {
  const btn = document.getElementById('launch-game-btn');
  const text = document.getElementById('launch-btn-text');
  const icon = document.getElementById('launch-btn-icon');
  if (!btn || !text || !icon) return;

  btn.classList.toggle('is-running', mode === 'running');
  btn.disabled = mode === 'launching';
  icon.classList.remove('hidden');

  if (mode === 'running') {
    icon.innerHTML = '<rect x="6" y="6" width="12" height="12" rx="1.5"></rect>';
    text.textContent = 'Stop';
  } else {
    icon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"></polygon>';
    text.textContent = mode === 'launching' ? 'Starting' : 'Play';
  }
}

function handleLaunchGame() {
  if (launchPhase === 'running') {
    stopGame();
    return;
  }
  if (launchPhase === 'launching') return;
  launch();
}

async function launch(server = null) {
  if (launchPhase !== 'idle') return;

  if (document.getElementById('auth-view')?.classList.contains('hidden') === false) {
    showToast('Sign in before launching.', 'error');
    return;
  }

  if (playEdition === 'rust') {
    launchRust();
    return;
  }

  const profile = activeProfileSafe();
  if (!window.electronAPI?.launchProfile) {
    showToast('Launching only works in the desktop app.', 'error');
    return;
  }

  /* Another profile being open is fine — that is the point of instances — but
     two copies of the same one would share a save folder. */
  if (typeof INSTANCES !== 'undefined' && (INSTANCES.sessions || []).some((s) => s.profileId === profile.id)) {
    showToast(`${profile.name} is already running. Switch profile to start another build.`, 'info');
    return;
  }

  launchPhase = 'launching';
  lastGameLines = [];
  setLaunchButton('launching');
  updateStatusLine();
  showDownloadOverlay();

  const result = await window.electronAPI.launchProfile({ profileId: profile.id, server });
  if (!result?.success) {
    launchPhase = 'idle';
    hideDownloadOverlay();
    setLaunchButton('idle');
    updateStatusLine();
    showToast(result?.message || 'Could not start Minecraft.', 'error');
    return;
  }

  // A missing build for this version is normal, but a network failure means the
  // player loses FlashClient features without any visible reason.
  const modFail = result?.clientMod?.reason;
  if (modFail === 'timeout' || modFail === 'unreachable') {
    showToast('Could not download the FlashClient mod. Starting without it.', 'error');
  }

  // A crash can land before this promise resolves. The exit handler already
  // reset the UI and reported it, so do not flip the button back to running.
  const state = await window.electronAPI.getGameState?.();
  const mine = state?.sessions?.find((s) => s.profileId === profile.id);
  if (!mine || mine.phase !== 'running') {
    launchPhase = 'idle';
    hideDownloadOverlay();
    setLaunchButton('idle');
    updateStatusLine();
    return;
  }

  launchPhase = 'running';
  hideDownloadOverlay();
  setLaunchButton('running');
  updateStatusLine();

  /* Once a second build is open, say where to manage it — the Play screen only
     ever shows one. */
  const others = (state.sessions || []).length - 1;
  showToast(
    server
      ? `Joining ${server.label || server.host}…`
      : others
        ? `${profile.gameVersion} is running alongside ${others} other instance${others === 1 ? '' : 's'}.`
        : `Minecraft ${profile.gameVersion} is running.`,
    'success'
  );
}

/* Horizon keeps its own window, but Flash Client launches it with
   `horizon-launcher play` so the game starts directly. */
async function launchRust() {
  if (rustLaunching) return;
  if (!window.electronAPI?.launchHorizon) {
    showToast('Launching only works in the desktop app.', 'error');
    return;
  }

  if (!horizonState.found) {
    await offerHorizonInstall();
    return;
  }

  rustLaunching = true;
  try {
    const result = await window.electronAPI.launchHorizon();
    if (!result?.success) {
      /* The launcher re-detects before giving up, so a miss here is a real
         miss: Horizon is not on this PC. Walk them through installing it. */
      if (result?.found === false) {
        await offerHorizonInstall();
        return;
      }
      showToast(result?.message || 'Could not open Horizon.', 'error');
      return;
    }

    showToast('Starting Minecraft Rust Edition through Horizon…', 'success');
  } finally {
    rustLaunching = false;
  }
}

/* There is no Rust Edition without Horizon: it has no game files of its own
   and reads them from the player's own Minecraft 26.3 install. So a missing
   launcher is not an error to report, it is the first step of a setup. */

let horizonSetupPoller = null;

function openHorizonSetup(info) {
  const modal = document.getElementById('horizon-setup-modal');
  const reqs = document.getElementById('horizon-setup-requirements');
  const steps = document.getElementById('horizon-setup-steps');
  if (!modal) return;
  reqs.innerHTML = (info?.requirements || []).map((r) => `<li>${profileText(r)}</li>`).join('');
  steps.innerHTML = (info?.steps || []).map((s) => `<li>${profileText(s)}</li>`).join('');
  showHorizonSetupContent();
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeHorizonSetup() {
  const modal = document.getElementById('horizon-setup-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  stopHorizonSetupPoll();
}

function showHorizonSetupProgress(text) {
  document.getElementById('horizon-setup-content')?.classList.add('hidden');
  document.getElementById('horizon-setup-progress')?.classList.remove('hidden');
  const status = document.getElementById('horizon-setup-status');
  if (status && text) status.textContent = text;
}

function showHorizonSetupContent() {
  document.getElementById('horizon-setup-content')?.classList.remove('hidden');
  document.getElementById('horizon-setup-progress')?.classList.add('hidden');
}

function stopHorizonSetupPoll() {
  if (horizonSetupPoller) {
    clearInterval(horizonSetupPoller);
    horizonSetupPoller = null;
  }
}

async function horizonSetupDownload() {
  const opened = await window.electronAPI?.openHorizonDownload?.('install');
  if (!opened?.success) {
    showToast('Could not open your browser.', 'error');
    return;
  }
  showHorizonSetupProgress('Waiting for Horizon installer to finish…');
  startHorizonSetupPoll();
}

async function horizonSetupInstallFromFile() {
  const picked = await window.electronAPI?.pickHorizonInstaller?.();
  if (!picked?.success) {
    if (!picked?.canceled) showToast('Could not read that installer.', 'error');
    return;
  }
  const installed = await window.electronAPI?.installHorizon?.(picked.path);
  if (!installed?.success) {
    showToast(installed?.message || 'Could not run installer.', 'error');
    return;
  }
  showHorizonSetupProgress('Running installer…');
  startHorizonSetupPoll();
}

function horizonSetupLocate() {
  closeHorizonSetup();
  switchTab('settings');
}

function startHorizonSetupPoll() {
  stopHorizonSetupPoll();
  horizonSetupPoller = setInterval(async () => {
    const status = await window.electronAPI?.horizonStatus?.();
    if (status?.found) {
      stopHorizonSetupPoll();
      closeHorizonSetup();
      horizonState = { found: true, path: status.path };
      renderEditionState();
      setLaunchButton(launchPhase);
      updateStatusLine();
      showToast('Horizon installed. Starting Rust Edition…', 'success');
      launchRust();
    }
  }, 2500);
}

async function offerHorizonInstall() {
  const info = await window.electronAPI?.horizonBootstrap?.();
  if (info?.installed) {
    horizonState = { found: true, path: info.path || '' };
    renderEditionState();
    setLaunchButton(launchPhase);
    updateStatusLine();
    showToast('Horizon launcher found. Starting it…', 'success');
    return launchRust();
  }
  openHorizonSetup(info);
}

/* The Play button stops the active profile's own session, never every game:
   a second instance running in the background is not the one it owns. */
async function stopGame() {
  const profile = activeProfileSafe();
  const result = await window.electronAPI?.stopGame?.(profile.id);
  if (!result?.success) showToast(result?.message || 'Minecraft is not running.', 'error');
  else showToast('Stopping Minecraft…', 'info');
}

/* The Play screen follows the active profile's own session. A launch of some
   other profile arrives here too, and must not flip this button. */
function handleGameState(state) {
  if (!state) return;

  const mine = state.profileId && typeof activeProfile === 'function' && state.profileId === activeProfile().id;
  const hasSessions = Array.isArray(state.sessions) ? state.sessions.length > 0 : false;

  if (mine && state.phase === 'launching') {
    launchPhase = 'launching';
    if (document.getElementById('download-overlay')?.classList.contains('hidden')) showDownloadOverlay();
  } else if (mine && state.phase === 'running') {
    launchPhase = 'running';
    hideDownloadOverlay();
  } else if (!mine) {
    /* No session for this profile: it is idle whatever the neighbours do. */
    launchPhase = 'idle';
    if (state.phase !== 'launching') hideDownloadOverlay();
  } else if (mine && state.phase === 'idle') {
    launchPhase = 'idle';
    hideDownloadOverlay();
  }

  setLaunchButton(launchPhase);
  updateStatusLine();
  if (typeof updateInstanceBadge === 'function') updateInstanceBadge();
}

function handleGameExit(info) {
  /* An exit for a profile this screen is not showing changes nothing here;
     instances.js reports it by name instead. */
  const mine = info?.profileId && typeof activeProfile === 'function' && info.profileId === activeProfile().id;
  if (!mine) return;

  const wasActive = launchPhase !== 'idle';
  launchPhase = 'idle';
  hideDownloadOverlay();
  setLaunchButton('idle');
  updateStatusLine();

  if (!wasActive) return;

  const crashed = info && info.code !== 0 && !info.signal && info.code != null;
  if (crashed) {
    const hint = lastGameLines.slice(-2).join(' ').slice(0, 160);
    showToast(`Minecraft closed with exit code ${info.code}.${hint ? ` ${hint}` : ''}`, 'error');
  } else {
    showToast('Minecraft closed.', 'info');
  }
}

function updateStatusLine() {
  const line = document.getElementById('play-status-line');
  if (!line) return;

  if (playEdition === 'rust') {
    line.textContent = horizonState.found
      ? 'Rust Edition · Horizon'
      : 'Rust Edition · Horizon not installed — press Play to set it up';
    return;
  }

  const profile = activeProfileSafe();
  const target = quickTarget();
  const others = instanceCountLabel();

  if (launchPhase === 'running') {
    line.textContent = `${profile.gameVersion} · ${profile.ram} GB · running`;
  } else if (launchPhase === 'launching') {
    const title = downloadState ? PHASE_TITLES[downloadState.phase] : 'Starting';
    line.textContent = `${title || 'Starting'} — ${profile.name}`;
  } else {
    const bits = [`${loaderName(profile.loader)} · ${profile.ram} GB`];
    if (target) bits.push(target.name);
    /* A running instance elsewhere is worth saying here: the Play button is
       idle, which otherwise looks like nothing is happening. */
    if (others) bits.unshift(others);
    line.textContent = bits.join(' · ');
  }
}

/* ---------- news sheet ---------- */

function toggleNewsSheet(force) {
  const sheet = document.getElementById('news-sheet');
  const chev = document.getElementById('news-toggle-chev');
  if (!sheet) return;

  const willOpen = typeof force === 'boolean' ? force : sheet.classList.contains('hidden');
  if (willOpen) renderNewsFeed();
  sheet.classList.toggle('hidden', !willOpen);
  chev?.style.setProperty('transform', willOpen ? 'rotate(180deg)' : 'rotate(0deg)');
}

function openNewsSheet() {
  switchTab('play');
  toggleNewsSheet(true);
}

/* ---------- dismissal ---------- */

/* R is the shortcut printed on the Quick play button, so it has to do
   exactly what the button does — and only while Play is actually on screen. */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'r' && e.key !== 'R') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  const playView = document.getElementById('play-view');
  if (!playView || playView.classList.contains('hidden')) return;
  if (document.getElementById('auth-view') && !document.getElementById('auth-view').classList.contains('hidden')) return;
  if (!document.getElementById('download-overlay')?.classList.contains('hidden')) return;
  e.preventDefault();
  quickPlay();
});

document.addEventListener('click', (e) => {
  const version = document.getElementById('version-flyout');
  const quick = document.getElementById('quick-flyout');
  const account = document.getElementById('account-menu');

  if (version && !version.contains(e.target) && !document.getElementById('version-trigger-btn')?.contains(e.target)) {
    version.classList.add('hidden');
  }
  if (quick && !quick.contains(e.target) && !document.getElementById('quick-play-btn')?.contains(e.target)) {
    quick.classList.add('hidden');
  }
  if (account && !account.contains(e.target) && !document.getElementById('user-profile-badge')?.contains(e.target)) {
    account.classList.add('hidden');
  }
});

/* ---------- Play artwork ---------- */

/* The Play window keeps the launcher's own summer artwork; there is no
   alternate takeover look any more. */

document.addEventListener('DOMContentLoaded', async () => {
  window.electronAPI?.onLaunchProgress?.(handleLaunchProgress);
  window.electronAPI?.onGameState?.(handleGameState);
  window.electronAPI?.onGameExit?.(handleGameExit);
  window.electronAPI?.onGameLog?.((payload) => {
    if (!payload?.line) return;
    lastGameLines.push(payload.line);
    if (lastGameLines.length > 40) lastGameLines.shift();
  });

  window.electronAPI?.getGameState?.().then((state) => {
    if (state) handleGameState(state);
  });

  const settings = await window.electronAPI?.getSettings?.();
  if (settings) {
    SETTINGS = settings;
    playEdition = settings.playEdition === 'rust' ? 'rust' : 'java';
  }
  await refreshHorizonState();
  refreshPlayChrome();
});
