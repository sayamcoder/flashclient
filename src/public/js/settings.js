/* Settings live in the main process (userData/settings.json). This page is
   just a view over that file; every control writes immediately. */

let SETTINGS = {};
let JAVA_RUNTIMES = null;
let JAVA_ERROR = '';

const SETTING_ROWS = ['discordRpc', 'minigame', 'newsButton', 'minimizeOnLaunch', 'autoInstallJava', 'performanceMods', 'autoUpdate', 'runInBackground', 'backgroundNotice'];

async function loadSettings() {
  if (!window.electronAPI?.getSettings) return;
  SETTINGS = await window.electronAPI.getSettings();
  renderSettings();
}

function renderSettings() {
  for (const key of SETTING_ROWS) {
    const input = document.getElementById(`setting-${key}`);
    if (input) input.checked = SETTINGS[key] !== false;
  }

  renderSettingsRam();
  applyNewsButton();
  refreshJavaInfo();
  refreshHorizonInfo();
}

function applyNewsButton() {
  const button = document.getElementById('news-button');
  if (!button) return;
  const on = SETTINGS.newsButton !== false;
  button.classList.toggle('hidden', !on);
  if (!on) toggleNewsSheet(false);
}

function renderSettingsRam() {
  const wrap = document.getElementById('settings-ram-options');
  if (!wrap) return;

  const current = Number(SETTINGS.defaultRam) || 4;
  wrap.innerHTML = [2, 4, 6, 8].map((gb) => {
    const active = gb === current;
    return `<button type="button" onclick="settingsSetRam(${gb})"
      class="h-7 rounded font-mono text-[11px] border transition-colors cursor-pointer ${active ? 'bg-white/[0.1] border-white/25 text-white' : 'bg-transparent border-white/10 text-white/45 hover:text-white hover:border-white/20'}">${gb} GB</button>`;
  }).join('');
}

async function settingsSetRam(gb) {
  SETTINGS = await window.electronAPI?.setSettings?.({ defaultRam: gb });
  renderSettingsRam();
}

async function settingsToggle(key, value) {
  SETTINGS = await window.electronAPI?.setSettings?.({ [key]: Boolean(value) });
  applyNewsButton();
  if (key === 'minigame' && typeof MiniGame !== 'undefined') {
    const overlayOpen = !document.getElementById('download-overlay')?.classList.contains('hidden');
    if (overlayOpen && !value) MiniGame.stop();
    if (overlayOpen && value) MiniGame.start(true);
  }
}

async function refreshJavaInfo() {
  const list = document.getElementById('settings-java-list');
  if (!list || !window.electronAPI?.javaInfo) return;

  list.innerHTML = '<p class="text-[11px] text-white/30">Scanning this PC…</p>';
  const result = await window.electronAPI.javaInfo();
  JAVA_RUNTIMES = result?.runtimes || [];
  JAVA_ERROR = result?.success === false ? 'Could not scan for Java.' : '';

  if (!JAVA_RUNTIMES.length) {
    list.innerHTML = `<p class="text-[11px] ${JAVA_ERROR ? 'text-[#ef8b8b]' : 'text-white/30'}">${JAVA_ERROR || 'No Java found. The right version is downloaded on first launch.'}</p>`;
    return;
  }

  const managedRoot = String(result?.managed || '').toLowerCase();
  list.innerHTML = JAVA_RUNTIMES.map((runtime) => {
    const managed = managedRoot && String(runtime.path || '').toLowerCase().startsWith(managedRoot);
    return `
      <div class="flex items-center gap-2.5 bg-white/[0.025] border border-white/[0.06] rounded-md px-2.5 py-1.5">
        <span class="w-9 h-6 shrink-0 rounded bg-white/[0.06] border border-white/10 text-[10px] font-mono text-white/60 flex items-center justify-center">J${runtime.major}</span>
        <span class="flex-1 min-w-0 text-[11px] font-mono text-white/45 truncate" title="${runtime.path}">${runtime.path}</span>
        <span class="text-[10px] font-mono text-white/30 shrink-0">${runtime.version}</span>
        ${managed ? '<span class="text-[10px] font-medium text-[#5ec36a] shrink-0">managed</span>' : ''}
      </div>`;
  }).join('');
}

async function refreshHorizonInfo() {
  const line = document.getElementById('horizon-status-line');
  if (!line || !window.electronAPI?.horizonStatus) return;

  line.className = 'settings-hint';
  line.textContent = 'Looking for horizon-launcher.exe…';

  const result = await window.electronAPI.horizonStatus();
  if (result?.found) {
    line.className = 'settings-hint font-mono text-white/45 truncate';
    line.textContent = result.path;
    line.title = result.path;
  } else {
    line.className = 'settings-hint text-[#f0c67a]';
    line.textContent = 'Not installed. Switch to Rust Edition on Play, or download it from playhorizon.dev.';
    line.title = '';
  }

  // Keep the Play switch in step when the path was just linked.
  if (typeof refreshHorizonState === 'function') refreshHorizonState();
}

async function detectHorizonLauncher() {
  const line = document.getElementById('horizon-status-line');
  if (line) {
    line.className = 'settings-hint';
    line.textContent = 'Scanning this PC…';
  }
  /* settings.js asks for the same IPC as play.js, so a fresh install found
     here also unblocks Play without a restart. */
  const result = await window.electronAPI?.horizonStatus?.();
  if (result?.found) showToast('Horizon launcher found.', 'success');
  else showToast('Horizon launcher not installed. Download it from playhorizon.dev.', 'error');
  refreshHorizonInfo();
}

async function pickHorizonLauncher() {
  const result = await window.electronAPI?.pickHorizon?.();
  if (!result?.success) {
    if (!result?.canceled) showToast('That file could not be opened.', 'error');
    refreshHorizonInfo();
    return;
  }
  showToast('Horizon launcher linked.', 'success');
  refreshHorizonInfo();
}

/* The download button on the official site. Main decides the URL, so the
   renderer cannot be talked into opening anywhere else. */
async function openHorizonDownload() {
  const result = await window.electronAPI?.openHorizonDownload?.('install');
  if (!result?.success) {
    showToast(result?.message || 'Could not open your browser.', 'error');
    return;
  }
  showToast('Opened playhorizon.dev. Install Horizon, then choose Detect.', 'info');
}

function openDataFolder(which) {
  window.electronAPI?.openDataFolder?.(which);
}

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
});
