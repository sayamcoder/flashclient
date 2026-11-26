/* Instances — the live list of running Minecraft processes. The main process
   keeps one session per profile and pushes the whole set on every change, so
   this file only paints what it is given and ticks the uptime clocks. */

let INSTANCES = { phase: 'idle', count: 0, runningCount: 0, sessions: [] };
let instanceTicker = null;

/* Uptime comes from the main process's start stamp rather than a counter here,
   so a window that was in the background for ten minutes still reads right. */
function instanceUptime(startedAt) {
  if (!startedAt) return '0:00';
  const total = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function instanceStartedLabel(startedAt) {
  if (!startedAt) return '';
  const d = new Date(startedAt);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function instancePhaseLabel(session) {
  if (session.phase === 'launching') return 'Starting';
  if (session.phase === 'running') return 'Running';
  return 'Stopped';
}

function instanceDotTone(session) {
  if (session.phase === 'launching') return 'bg-[#e0a35d] animate-pulse';
  if (session.phase === 'running') return 'bg-[#4cbb5e]';
  return 'bg-white/25';
}

/* Same min-w-0 discipline as the picker row: the name column is the only one
   allowed to shrink, and the version badge is capped so a long label like
   "1.21.11 · Fabric" ellipsises instead of shoving Stop off the row. */
function instanceRow(session) {
  const tone = loaderTone(session.loader);
  const busy = session.phase === 'launching';
  const name = profileText(session.name);
  const badge = `${profileText(session.gameVersion)} · ${loaderName(session.loader)}`;

  return `
    <div class="inst-row panel rounded-xl px-4 py-3 flex items-center gap-3" data-profile="${profileText(session.profileId)}" title="${name}&#10;${badge}">
      <span class="w-1.5 h-1.5 rounded-full shrink-0 ${instanceDotTone(session)}"></span>

      <div class="block min-w-0 flex-1 overflow-hidden">
        <div class="flex items-center gap-2 min-w-0">
          <span class="block min-w-0 flex-1 text-[12.5px] font-semibold text-white truncate">${name}</span>
          <span class="shrink-0 max-w-[120px] flex items-center gap-1.5 px-1.5 py-0.5 rounded bg-white/[0.05] text-[10px] font-mono text-white/45 overflow-hidden">
            <span class="w-1 h-1 rounded-full shrink-0 ${tone}"></span>
            <span class="truncate">${badge}</span>
          </span>
        </div>
        <p class="text-[11px] text-white/30 mt-1 truncate">
          ${session.server?.label
            ? `Joining ${profileText(session.server.label)}`
            : busy
              ? 'Preparing files…'
              : `Started ${profileText(instanceStartedLabel(session.startedAt))}`}
          ${session.pid ? `<span class="font-mono text-white/20"> · pid ${session.pid}</span>` : ''}
        </p>
      </div>

      <div class="shrink-0 w-[64px] text-right">
        <p class="text-[12px] font-mono text-white/70 tabular-nums" data-uptime="${session.startedAt}">${instanceUptime(session.startedAt)}</p>
        <p class="text-[10px] text-white/25 mt-0.5">${instancePhaseLabel(session)}</p>
      </div>

      <button type="button" onclick="stopInstance('${profileText(session.profileId)}')" data-busy="${busy ? '1' : '0'}"
              class="shrink-0 w-[62px] text-center h-7 rounded-md bg-white/[0.06] hover:bg-[#e04f4f]/20 border border-white/10 hover:border-[#e04f4f]/35 text-[11px] font-medium text-white/70 hover:text-[#ef8b8b] transition-colors cursor-pointer">
        ${busy ? 'Cancel' : 'Stop'}
      </button>
    </div>`;
}

function renderInstances() {
  const list = document.getElementById('instances-list');
  const empty = document.getElementById('instances-empty');
  const subtitle = document.getElementById('instances-subtitle');
  const stopAll = document.getElementById('instances-stop-all');
  if (!list) return;

  const sessions = (INSTANCES.sessions || []).slice().sort((a, b) => a.startedAt - b.startedAt);

  list.innerHTML = sessions.map(instanceRow).join('');
  empty?.classList.toggle('hidden', sessions.length > 0);
  empty?.classList.toggle('flex', sessions.length === 0);

  if (subtitle) {
    if (!sessions.length) {
      subtitle.textContent = 'Nothing is running';
    } else {
      const running = sessions.filter((s) => s.phase === 'running').length;
      const starting = sessions.length - running;
      const bits = [`${running} running`];
      if (starting) bits.push(`${starting} starting`);
      subtitle.textContent = `${bits.join(' · ')} — closing the launcher keeps them alive`;
    }
  }

  if (stopAll) stopAll.disabled = sessions.length === 0;
  updateInstanceBadge();
  tickUptimes();
}

/* The tab and its count only exist while something is running, so a player who
   never opens this page still sees that the launcher is doing work. */
function updateInstanceBadge() {
  const tab = document.getElementById('instances-tab');
  const divider = document.getElementById('instances-tab-divider');
  const badge = document.getElementById('instances-badge');
  const count = document.getElementById('instances-badge-count');
  if (!tab) return;

  const total = INSTANCES.sessions?.length || 0;

  tab.classList.toggle('hidden', total === 0);
  divider?.classList.toggle('hidden', total === 0);

  if (badge) {
    badge.classList.toggle('hidden', total === 0);
    badge.classList.toggle('flex', total > 0);
  }
  if (count) count.textContent = String(total);
}

function tickUptimes() {
  const list = document.getElementById('instances-list');
  if (!list) return;
  list.querySelectorAll('[data-uptime]').forEach((el) => {
    el.textContent = instanceUptime(Number(el.dataset.uptime));
  });
}

function applyInstanceState(state) {
  if (!state) return;
  INSTANCES = state;
  renderInstances();

  /* The old single-game reading, kept in sync so Play and the tray agree with
     this tab. play.js owns launchPhase, so this only nudges it when the count
     changed because a game started or stopped outside the Play button. */
  const myProfile = typeof activeProfile === 'function' ? activeProfile() : null;
  const mine = myProfile && state.sessions?.find((s) => s.profileId === myProfile.id);

  if (typeof handleGameState === 'function' && mine) {
    handleGameState({ phase: mine.phase, profileId: mine.profileId });
    return;
  }

  /* No session for the active profile, but a neighbour's state still changed
     what the Play screen should say ("1 instance running"). The button stays
     idle here; only the status line is refreshed. */
  if (typeof updateStatusLine === 'function') updateStatusLine();
}

async function stopInstance(profileId) {
  const result = await window.electronAPI?.stopGame?.(profileId);
  if (!result?.success) {
    showToast(result?.message || 'Could not stop that instance.', 'error');
    return;
  }
  showToast('Stopping Minecraft…', 'info');
}

async function stopAllInstances() {
  if (!INSTANCES.sessions?.length) return;
  const result = await window.electronAPI?.stopGame?.();
  if (!result?.success) {
    showToast(result?.message || 'Nothing to stop.', 'error');
    return;
  }
  showToast(
    result.stopped?.length === 1 ? 'Stopping 1 instance…' : `Stopping ${result.stopped?.length || 0} instances…`,
    'info'
  );
}

/* ---------- launch picker ---------- */

/* The row is a <button>, which defaults to `display: inline-block` and sizes to
   its content — so a long profile name used to push the row past the modal's
   420px and spill text over the rounded edge. We make it a flex box, clamp it
   to the modal's width, and keep the text column from taking its intrinsic
   min-width. The inner text spans are `block` so `truncate` can ellipsize. */
function launchPickerRow(profile) {
  const busy = INSTANCES.sessions?.some((s) => s.profileId === profile.id);
  const name = profileText(profile.name);
  const meta = `${profileText(profile.gameVersion)} · ${loaderName(profile.loader)} · ${profile.ram} GB`;
  return `
    <button type="button" onclick="launchFromPicker('${profileText(profile.id)}')" ${busy ? 'disabled' : ''}
            title="${name}&#10;${meta}"
            class="w-full min-w-0 text-left flex items-center gap-2.5 px-2.5 py-2 rounded-lg border transition-colors ${busy
              ? 'border-transparent bg-transparent opacity-45 cursor-default'
              : 'bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.05] hover:border-white/15 cursor-pointer'}">
      <span class="w-1.5 h-1.5 rounded-full shrink-0 ${busy ? 'bg-[#4cbb5e]' : profile.ready ? loaderTone(profile.loader) : 'bg-transparent border border-white/30'}"></span>
      <span class="block min-w-0 flex-1 overflow-hidden">
        <span class="block text-[12px] font-medium text-white/90 truncate">${name}</span>
        <span class="block text-[10px] font-mono text-white/35 truncate mt-0.5">${meta}</span>
      </span>
      <span class="shrink-0 text-[10px] font-mono text-white/30">${busy ? 'running' : ''}</span>
    </button>`;
}

function renderLaunchPicker() {
  const list = document.getElementById('launch-picker-list');
  if (!list) return;
  if (!PROFILES.length) {
    list.innerHTML = '<p class="px-2 py-6 text-center text-[11px] text-white/30">No profiles yet.</p>';
    return;
  }
  list.innerHTML = PROFILES.map(launchPickerRow).join('');
}

/* The modal lives inside #instances-view in the markup, and that view carries
   `.hidden`. A `position: fixed` child of a `display: none` ancestor is still
   not rendered, so the panel measured 0x0 and appeared as a 420px-tall empty
   overlay whenever something opened it while another tab was active. Reparent
   it to <body> so the overlay is independent of whichever tab is showing. */
function mountLaunchPicker() {
  const modal = document.getElementById('launch-picker');
  if (!modal || modal.parentElement === document.body) return modal;
  document.body.appendChild(modal);
  return modal;
}

async function openLaunchPicker() {
  const modal = mountLaunchPicker();
  if (!modal) return;
  renderLaunchPicker();
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  if (!PROFILE_VERSIONS) ensureProfileVersions();
}

function closeLaunchPicker() {
  const modal = document.getElementById('launch-picker');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

async function launchFromPicker(profileId) {
  closeLaunchPicker();
  await launchProfileFromList(profileId);
}

/* A launch started outside Play goes through the same overlay so the download
   progress has somewhere to land. */
async function launchProfileFromList(profileId) {
  const profile = PROFILES.find((p) => p.id === profileId);
  if (!profile) return;

  if (!window.electronAPI?.launchProfile) {
    showToast('Launching only works in the desktop app.', 'error');
    return;
  }

  showToast(`Starting ${profile.name}…`, 'info');
  const result = await window.electronAPI.launchProfile({ profileId });

  if (!result?.success) {
    showToast(result?.message || 'Could not start Minecraft.', 'error');
    return;
  }
  showToast(`${profile.name} is running.`, 'success');
}

function handleInstanceExit(payload) {
  if (!payload?.name) return;
  const crashed = payload.code !== 0 && payload.code != null && !payload.signal;
  showToast(
    crashed
      ? `${payload.name} closed with exit code ${payload.code}.`
      : `${payload.name} closed.`,
    crashed ? 'error' : 'info'
  );
}

document.addEventListener('DOMContentLoaded', async () => {
  window.electronAPI?.onInstancesChanged?.(applyInstanceState);
  window.electronAPI?.onGameState?.(applyInstanceState);
  window.electronAPI?.onGameExit?.(handleInstanceExit);
  window.electronAPI?.onOpenInstances?.(() => switchTab('instances'));

  const state = await window.electronAPI?.listInstances?.();
  if (state) applyInstanceState(state);

  /* One shared second ticker; renderInstances restarts nothing. */
  if (!instanceTicker) instanceTicker = setInterval(tickUptimes, 1000);
});
