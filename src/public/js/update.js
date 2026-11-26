/* Launcher update screen. The main process owns the state machine (checking,
   downloading, ready); this file only draws it and forwards clicks. */

let UPDATE = null;
let UPDATE_LAST_PHASE = '';

const UPDATE_BUSY = ['checking', 'downloading', 'installing'];
const UPDATE_STRIP_PHASES = ['available', 'downloading', 'ready', 'installing'];

function updateEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatUpdateBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function formatUpdateDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return '';
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function updateNotes(state) {
  const notes = Array.isArray(state.notes) ? state.notes : [];
  if (!notes.length) return '';
  return `<div class="mt-4 flex flex-col gap-2 max-w-[520px]">${notes
    .map((line) => `<p class="release-note">${updateEscape(line)}</p>`)
    .join('')}</div>`;
}

function updateMetaLine(state) {
  const size = state.size ? `${formatUpdateBytes(state.size)} installer` : '';
  const published = formatUpdateDate(state.publishedAt);
  return [
    size,
    state.current ? `you have v${updateEscape(state.current)}` : '',
    published
  ].filter(Boolean).join(' <span class="text-white/20">·</span> ');
}

function updateVersionBlock(version, meta) {
  return `
    <h2 class="release-version mt-3">${updateEscape(version || '—')}</h2>
    ${meta ? `<p class="mt-2 text-[11.5px] text-white/45">${meta}</p>` : ''}`;
}

function updateActions(primary, secondary) {
  return `
    <div class="mt-6 flex flex-wrap items-center gap-2">
      ${primary}
      ${secondary || ''}
    </div>`;
}

function updateCardAvailable(state) {
  return `
    <p class="page-eyebrow">Update available</p>
    ${updateVersionBlock(state.latest, updateMetaLine(state))}
    <h3 class="release-title mt-4">What's new in ${updateEscape(state.latest)}</h3>
    ${updateNotes(state)}
    ${state.message ? `<p class="mt-3 text-[11.5px] text-[#ef8b8b] max-w-[520px]">${updateEscape(state.message)}</p>` : ''}
    ${updateActions(
      '<button type="button" onclick="downloadLauncherUpdate()" class="btn-signal">Download update</button>',
      '<button type="button" onclick="switchTab(\'play\')" class="btn-quiet">Not now</button>'
    )}`;
}

function updateCardDownloading(state) {
  const progress = state.progress || { received: 0, total: state.size || 0, percent: 0 };
  const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  const total = progress.total || state.size;

  return `
    <p class="page-eyebrow">Downloading</p>
    ${updateVersionBlock(state.latest, 'Building the installer in the background')}
    <div class="mt-6 max-w-[520px]">
      <div class="flex items-baseline justify-between mb-2 text-[11px] font-mono text-white/40">
        <span>${formatUpdateBytes(progress.received)} of ${formatUpdateBytes(total)}</span>
        <span class="text-white/70">${percent}%</span>
      </div>
      <div class="release-progress"><div class="release-progress-fill" style="width: ${percent}%"></div></div>
      <p class="mt-3 text-[11.5px] leading-relaxed text-white/40">Keep the launcher open. Installing is still your call.</p>
    </div>`;
}

function updateCardReady(state) {
  return `
    <p class="page-eyebrow">Ready to install</p>
    ${updateVersionBlock(state.latest, `Downloaded and checked · ${formatUpdateBytes(state.size)}`)}
    <h3 class="release-title mt-4">Restart to finish updating</h3>
    ${updateNotes(state)}
    <p class="mt-4 max-w-[520px] text-[11.5px] leading-relaxed text-white/40">The launcher closes, installs the update and opens again. Close Minecraft first — the installer needs the game files released.</p>
    ${updateActions(
      '<button type="button" onclick="installLauncherUpdate()" class="btn-signal">Restart and update</button>',
      '<button type="button" onclick="switchTab(\'play\')" class="btn-quiet">Later</button>'
    )}`;
}

function updateCardInstalling(state) {
  return `
    <p class="page-eyebrow">Installing</p>
    ${updateVersionBlock(state.latest)}
    <h3 class="release-title mt-4">Replacing this build</h3>
    <p class="mt-3 max-w-[520px] text-[11.5px] leading-relaxed text-white/45">The launcher is closing so the installer can take over. It reopens on ${updateEscape(state.latest)}.</p>`;
}

function updateCardCurrent(state) {
  return `
    <p class="page-eyebrow">Up to date</p>
    ${updateVersionBlock(state.current, 'Latest build · checked automatically')}
    <h3 class="release-title mt-4">You're running the newest version</h3>
    <p class="mt-3 max-w-[520px] text-[11.5px] leading-relaxed text-white/45">Nothing to install right now. The launcher checks again every half hour while it stays open.</p>`;
}

function updateCardProblem(state) {
  if (state.phase === 'unconfigured') {
    return `
    <p class="page-eyebrow">Manual updates</p>
    <h3 class="release-title mt-4">This build updates by hand</h3>
    <p class="mt-3 max-w-[520px] text-[11.5px] leading-relaxed text-white/45">${updateEscape(state.message || 'Download the newest build from the GitHub releases page.')}</p>`;
  }

  const pending = state.phase === 'checking' || state.phase === 'idle';
  const title = pending ? 'Looking for updates' : 'Could not check';
  const fallback = state.phase === 'checking'
    ? 'Contacting the update server…'
    : 'No check has run yet. Use Check for updates above.';

  return `
    <p class="page-eyebrow">${title}</p>
    <h3 class="release-title mt-4">${pending ? 'Reading the release feed' : 'The update feed did not answer'}</h3>
    <p class="mt-3 max-w-[520px] text-[11.5px] leading-relaxed text-white/45">${updateEscape(state.message || fallback)}</p>
    ${pending ? '' : updateActions('<button type="button" onclick="checkForLauncherUpdate()" class="btn-quiet">Try again</button>')}`;
}

function updateCardFor(state) {
  switch (state.phase) {
    case 'available': return updateCardAvailable(state);
    case 'downloading': return updateCardDownloading(state);
    case 'ready': return updateCardReady(state);
    case 'installing': return updateCardInstalling(state);
    case 'current': return updateCardCurrent(state);
    default: return updateCardProblem(state);
  }
}

function updateStripText(state) {
  const percent = Math.max(0, Math.min(100, Number(state.progress?.percent) || 0));
  if (state.phase === 'available') return `A new build <b>v${updateEscape(state.latest)}</b> is available.`;
  if (state.phase === 'downloading') return `Downloading <b>v${updateEscape(state.latest)}</b> — ${percent}%.`;
  if (state.phase === 'ready') return `<b>v${updateEscape(state.latest)}</b> is ready. Restart to install.`;
  if (state.phase === 'installing') return `Installing <b>v${updateEscape(state.latest)}</b>…`;
  return '';
}

/* The update page already explains the state and the Play page owns its whole
   canvas, so the strip only stands on working pages. */
function updateStripVisible() {
  if (!UPDATE) return false;
  if (!document.getElementById('update-strip')) return false;
  const updateOpen = !document.getElementById('update-view')?.classList.contains('hidden');
  return UPDATE_STRIP_PHASES.includes(UPDATE.phase) && !updateOpen && !document.body.classList.contains('on-play');
}

function renderUpdateStrip() {
  const strip = document.getElementById('update-strip');
  if (!strip || !UPDATE) return;

  const show = updateStripVisible();
  strip.classList.toggle('hidden', !show);
  renderUpdateBadge();
  if (!show) return;

  const ready = UPDATE.phase === 'ready';
  strip.innerHTML = `
    <span class="dot"></span>
    <p class="update-banner-text flex-1 min-w-0 truncate">${updateStripText(UPDATE)}</p>
    ${ready ? '<button type="button" onclick="installLauncherUpdate()" class="btn-signal btn-sm">Restart and update</button>' : ''}
    <button type="button" onclick="switchTab(\'update\')" class="btn-quiet btn-sm shrink-0">View</button>`;
}

function renderUpdateBadge() {
  const button = document.getElementById('update-button');
  const label = document.getElementById('update-button-label');
  const dot = document.getElementById('rail-update-dot');
  if (!UPDATE) return;

  const percent = Number(UPDATE.progress?.percent) || 0;
  let text = '';
  if (UPDATE.phase === 'available') text = `Update ${UPDATE.latest}`;
  else if (UPDATE.phase === 'downloading') text = `Downloading ${percent}%`;
  else if (UPDATE.phase === 'ready') text = 'Restart to update';
  else if (UPDATE.phase === 'installing') text = 'Updating…';

  // The standing strip already carries the same action, so the pill steps
  // aside while it is on screen.
  if (updateStripVisible()) text = '';

  if (button && label) {
    button.classList.toggle('hidden', !text);
    button.classList.toggle('flex', Boolean(text));
    if (text) {
      label.textContent = text;
      button.title = UPDATE.phase === 'ready'
        ? `Update ${UPDATE.latest} is ready to install`
        : text;
    }
  }

  dot?.classList.toggle('hidden', !text);
}

function renderUpdateFootnote() {
  const footnote = document.getElementById('update-footnote');
  if (!footnote || !UPDATE) return;

  if (UPDATE.checkedAt) {
    const time = new Date(UPDATE.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    footnote.textContent = `today at ${time}`;
  } else {
    footnote.textContent = 'not checked yet';
  }
}

function renderUpdate() {
  if (!UPDATE) return;

  const card = document.getElementById('update-card');
  if (card) card.innerHTML = updateCardFor(UPDATE);

  const subtitle = document.getElementById('update-subtitle');
  if (subtitle) {
    subtitle.textContent = UPDATE.current
      ? `This build is v${UPDATE.current}\nWindows 10 and 11`
      : 'Windows 10 and 11';
    subtitle.classList.toggle('whitespace-pre-line', Boolean(UPDATE.current));
  }

  const checkButton = document.getElementById('update-check-button');
  if (checkButton) {
    const busy = UPDATE_BUSY.includes(UPDATE.phase);
    checkButton.disabled = busy;
    checkButton.classList.toggle('opacity-40', busy);
    checkButton.textContent = UPDATE.phase === 'checking' ? 'Checking…' : 'Check for updates';
  }

  const toggle = document.getElementById('setting-autoUpdate');
  if (toggle && typeof SETTINGS === 'object') toggle.checked = SETTINGS.autoUpdate !== false;

  renderUpdateFootnote();
  renderUpdateBadge();
  renderUpdateStrip();
}

/* A downloaded update should not wait behind a pill: the page that explains it
   opens by itself once per version. */
function openUpdatePageOnce(state) {
  if (state.phase === 'current') {
    localStorage.removeItem('flash_update_page_for');
    return;
  }
  if (state.phase !== 'ready' || !state.latest) return;
  if (localStorage.getItem('flash_update_page_for') === state.latest) return;

  const auth = document.getElementById('auth-view');
  if (auth && !auth.classList.contains('hidden')) return;

  localStorage.setItem('flash_update_page_for', state.latest);
  switchTab('update');
}

function applyUpdateState(state) {
  if (!state) return;
  const previous = UPDATE_LAST_PHASE;
  UPDATE = state;
  UPDATE_LAST_PHASE = state.phase;
  renderUpdate();
  openUpdatePageOnce(state);

  if (state.phase === 'ready' && previous === 'downloading') {
    showToast(`Update ${state.latest} is ready. Press Restart and update to install it.`, 'success');
  }
}

async function checkForLauncherUpdate() {
  if (!window.electronAPI?.checkUpdate) return;
  if (UPDATE && UPDATE_BUSY.includes(UPDATE.phase)) return;
  applyUpdateState(await window.electronAPI.checkUpdate());
}

async function downloadLauncherUpdate() {
  if (!window.electronAPI?.downloadUpdate || !UPDATE) return;
  UPDATE = { ...UPDATE, phase: 'downloading', message: '', progress: { received: 0, total: UPDATE.size || 0, percent: 0 } };
  renderUpdate();
  applyUpdateState(await window.electronAPI.downloadUpdate());
}

async function installLauncherUpdate() {
  if (!window.electronAPI?.installUpdate) return;
  const result = await window.electronAPI.installUpdate();
  if (result?.success) return;

  showToast(result?.message || 'The update could not start.', 'error');
  if (/close minecraft/i.test(result?.message || '')) switchTab('play');
}

/* The top-bar pill installs straight away once the build is ready; before
   that it is a shortcut to this page. */
function handleUpdatePill() {
  if (UPDATE?.phase === 'ready') installLauncherUpdate();
  else switchTab('update');
}

document.addEventListener('DOMContentLoaded', async () => {
  const api = window.electronAPI;
  if (!api?.getUpdateState) return;

  api.onUpdateState?.((state) => applyUpdateState(state));
  applyUpdateState(await api.getUpdateState());
});
