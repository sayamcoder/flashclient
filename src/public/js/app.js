const TAB_VIEWS = ['play', 'instances', 'profiles', 'mods', 'shaders', 'resourcepacks', 'skins', 'cosmetics', 'friends', 'servers', 'settings', 'update'];

/* The header keeps one slot for all content tools so the row stays short.
   The key order here is also the order shown in the dropdown. */
const CONTENT_TABS = {
  mods: 'Mods',
  shaders: 'Shaders',
  resourcepacks: 'Resource Packs',
  skins: 'Skins',
  cosmetics: 'Cosmetics'
};

function toggleContentMenu(force) {
  const menu = document.getElementById('content-menu');
  if (!menu) return;
  const open = typeof force === 'boolean' ? force : menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !open);
  document.getElementById('content-menu-btn')?.setAttribute('aria-expanded', String(open));
}

function closeContentMenu() {
  toggleContentMenu(false);
}

function syncContentMenu(tab) {
  const label = document.getElementById('content-menu-label');
  if (label) label.textContent = CONTENT_TABS[tab] || 'Content';
  document.querySelectorAll('#content-menu [data-content-tab]').forEach((el) => {
    el.classList.toggle('is-active', el.dataset.contentTab === tab);
  });
}

function setBackdrop(on) {
  document.getElementById('world-backdrop')?.classList.toggle('opacity-100', on);
  // Content tabs use the ambient wash instead of the Play artwork.
  document.getElementById('app-ambient')?.classList.toggle('opacity-100', !on);
}

document.addEventListener('DOMContentLoaded', async () => {
  const saved = localStorage.getItem('flash_session');
  if (saved) {
    try {
      const session = JSON.parse(saved);

      // A Microsoft session is a live token, never stored — after a restart
      // there is nothing to resume, so ask for a fresh sign-in.
      if (session.type === 'microsoft') {
        localStorage.removeItem('flash_session');
      } else {
        const restored = await window.electronAPI?.sessionRestore?.(session.username);
        if (restored?.success) {
          enterDashboard({ ...session, username: restored.username, type: restored.type });
          return;
        }
        localStorage.removeItem('flash_session');
      }
    } catch (e) {
      localStorage.removeItem('flash_session');
    }
  }
  // The sign-in screen is the same world, just with the form on the left.
  setBackdrop(true);
});

function setChromeVisible(visible) {
  for (const id of ['dashboard-nav', 'user-profile-badge', 'dashboard-utilities']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.classList.toggle('hidden', !visible);
    el.classList.toggle('flex', visible);
  }
}

async function enterDashboard(user) {
  document.getElementById('auth-view')?.classList.add('hidden');
  setChromeVisible(true);

  document.getElementById('nav-username').textContent = user.username;
  document.getElementById('nav-user-avatar').src = user.avatar || SKIN_FALLBACK;
  document.getElementById('nav-account-type').textContent =
    user.type === 'microsoft' ? 'Microsoft account' : 'Cracked account';

  refreshStoredAvatar(user);

  if (typeof loadProfiles === 'function') await loadProfiles();
  if (typeof loadSettings === 'function') await loadSettings();
  if (typeof refreshPlayChrome === 'function') refreshPlayChrome();
  if (typeof refreshDailyRewards === 'function') refreshDailyRewards();
  switchTab('play');
}

/* Sessions saved before the chip used skin textures still hold a rendered
   head URL. Swap it for the head cut out of the account's own skin. */
async function refreshStoredAvatar(user) {
  if (!/^https?:/.test(user?.avatar || '')) return;
  const head = await headForUsername(user.username, 64);
  if (!head) return;

  document.getElementById('nav-user-avatar').src = head;
  const saved = JSON.parse(localStorage.getItem('flash_session') || 'null');
  if (saved?.username === user.username) {
    localStorage.setItem('flash_session', JSON.stringify({ ...saved, avatar: head }));
  }
}

function switchTab(tab) {
  const inContent = Boolean(CONTENT_TABS[tab]);
  document.querySelectorAll('.nav-tab').forEach(el => {
    el.classList.toggle('is-active', el.dataset.tab === tab || (inContent && el.dataset.tab === 'content'));
  });
  syncContentMenu(tab);
  closeContentMenu();

  TAB_VIEWS.forEach(v => {
    const el = document.getElementById(`${v}-view`);
    if (el) {
      el.classList.add('hidden');
      el.classList.remove('flex');
    }
  });

  const activeView = document.getElementById(`${tab}-view`);
  if (activeView) {
    activeView.classList.remove('hidden');
    activeView.classList.add('flex');
    // A short fade keeps tab switches from snapping; restart it every time.
    activeView.classList.remove('view-anim');
    void activeView.offsetWidth;
    activeView.classList.add('view-anim');
    // Long pages remember where they were; a fresh visit should start at the top.
    activeView.scrollTop = 0;
    activeView.querySelectorAll('.overflow-y-auto').forEach((el) => { el.scrollTop = 0; });
  }

  // The artwork is only the "window" on Play; the other tabs are working
  // lists and need a flat surface so their rows stay readable.
  setBackdrop(tab === 'play');

  if (tab !== 'play') {
    toggleNewsSheet(false);
    document.getElementById('account-menu')?.classList.add('hidden');
  }

  if (tab === 'skins' && typeof renderSkinsGrid === 'function') renderSkinsGrid();
  if (tab === 'cosmetics' && typeof loadCosmetics === 'function') loadCosmetics();
  if (tab === 'instances' && typeof renderInstances === 'function') renderInstances();
  if (tab === 'profiles') {
    if (typeof renderProfilesPage === 'function') renderProfilesPage();
    if (typeof ensureProfileVersions === 'function') ensureProfileVersions();
  }
  if (tab === 'mods' && typeof refreshMods === 'function') refreshMods();
  if (tab === 'shaders' && typeof refreshShaders === 'function') refreshShaders();
  if (tab === 'resourcepacks' && typeof refreshResourcepacks === 'function') refreshResourcepacks();
  if (tab === 'friends' && typeof loadFriends === 'function') loadFriends();
  if (tab === 'servers') {
    if (typeof renderServersList === 'function') renderServersList();
    if (typeof refreshServerStatus === 'function') refreshServerStatus();
  }
  if (tab === 'settings' && typeof renderSettings === 'function') renderSettings();
}

/* ---------- account menu ---------- */

function toggleAccountMenu(force) {
  const menu = document.getElementById('account-menu');
  if (!menu) return;
  if (typeof force === 'boolean') {
    menu.classList.toggle('hidden', !force);
  } else {
    menu.classList.toggle('hidden');
  }
}

function copyCurrentUsername() {
  const name = document.getElementById('nav-username')?.textContent.trim();
  if (!name) return;
  navigator.clipboard?.writeText(name);
  toggleAccountMenu(false);
  showToast(`${name} copied to clipboard.`, 'success');
}

/* ---------- dismissal ---------- */

/* Esc backs out of whatever is layered over the window. */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  document.getElementById('version-flyout')?.classList.add('hidden');
  document.getElementById('quick-flyout')?.classList.add('hidden');
  document.getElementById('account-menu')?.classList.add('hidden');
  closeContentMenu();
  toggleNewsSheet(false);
  if (typeof closeRewards === 'function' && !document.getElementById('rewards-modal')?.classList.contains('hidden')) {
    closeRewards();
    return;
  }
  const modal = document.getElementById('cracked-modal');
  if (modal && modal.style.display !== 'none') closeCrackedModal();
  if (typeof closeImportModal === 'function' && !document.getElementById('import-modal')?.classList.contains('hidden')) {
    closeImportModal();
  }
  if (typeof closeAddFriendModal === 'function' && !document.getElementById('add-friend-modal')?.classList.contains('hidden')) {
    closeAddFriendModal();
    return;
  }
  if (typeof chatPeer !== 'undefined' && chatPeer && typeof closeChat === 'function') {
    closeChat();
  }
});

/* A click anywhere else backs out of the Content menu. */
document.addEventListener('click', (event) => {
  const menu = document.getElementById('content-menu');
  if (!menu || menu.classList.contains('hidden')) return;
  if (menu.contains(event.target)) return;
  if (document.getElementById('content-menu-btn')?.contains(event.target)) return;
  closeContentMenu();
});

/* ---------- window controls ---------- */

function paintMaximizeState(maximized) {
  const maxIcon = document.getElementById('window-max-icon');
  const restoreIcon = document.getElementById('window-restore-icon');
  const btn = document.getElementById('window-max-btn');
  if (maxIcon) maxIcon.classList.toggle('hidden', maximized);
  if (restoreIcon) restoreIcon.classList.toggle('hidden', !maximized);
  if (btn) {
    const label = maximized ? 'Restore' : 'Maximize';
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }
}

async function toggleWindowMaximize() {
  if (!window.electronAPI?.toggleMaximize) return;
  try {
    paintMaximizeState(Boolean(await window.electronAPI.toggleMaximize()));
  } catch { /* window may be closing */ }
}

if (window.electronAPI?.isMaximized) {
  window.electronAPI.isMaximized().then(paintMaximizeState).catch(() => {});
  window.electronAPI.onMaximized?.((maximized) => paintMaximizeState(Boolean(maximized)));
}

/* Double-clicking the empty top bar still does what Windows users expect. */
document.querySelector('.app-drag-region')?.addEventListener('dblclick', (event) => {
  if (event.target.closest('.no-drag')) return;
  toggleWindowMaximize();
});

/* Ban enforcement: check ban status after session restore so a banned
   account can’t proceed past the login screen. */
async function checkBanOnLoad() {
  const session = localStorage.getItem('flash_session');
  if (!session) return;
  try {
    const data = JSON.parse(session);
    if (!data?.username) return;
    /* A restored session only stores name/type/avatar, so the UUID comes from
       the main process rather than localStorage. */
    const live = await window.electronAPI?.sessionGet?.();
    if (live && data.username && live.username !== data.username) return;

    const ban = await window.electronAPI?.banStatus?.({
      uuid: live?.uuid || data.uuid,
      name: data.username
    });
    if (ban?.banned) showBanOverlay(ban.ban || ban);
  } catch (err) {
    /* Ban check failure must not block launcher startup. */
  }
}
checkBanOnLoad();

/* Ban enforcement: if the backend says this account is blocked, show the
   ban screen and disable the launcher. */
function showBanOverlay(ban) {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-[9999] bg-[#09090b]/95 backdrop-blur-sm flex flex-col items-center justify-center text-white p-6';
  overlay.innerHTML = `
    <div class="max-w-md text-center">
      <div class="w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center mx-auto mb-4">
        <span class="text-2xl">🚫</span>
      </div>
      <h2 class="text-2xl font-bold mb-2">Account Banned</h2>
      <p class="text-white/70 mb-6">${ban?.reason || 'Your account has been suspended by an administrator.'}</p>
      <div class="text-left text-sm text-white/50 space-y-2">
        <p><strong>Type:</strong> ${ban?.type || 'account'}</p>
        <p><strong>Reason:</strong> ${ban?.reason || 'No reason provided'}</p>
        ${ban?.expiresAt ? `<p><strong>Expires:</strong> ${new Date(ban.expiresAt).toLocaleString()}</p>` : '<p><strong>Expires:</strong> Permanent</p>'}
      </div>
      <p class="mt-6 text-xs text-white/40">Contact an administrator to appeal this ban.</p>
    </div>
  `;
  document.body.appendChild(overlay);

  // Hide all interactive UI
  document.getElementById('auth-view')?.classList.add('hidden');
  document.getElementById('dashboard-nav')?.classList.add('hidden');
  document.getElementById('user-profile-badge')?.classList.add('hidden');
  document.getElementById('dashboard-utilities')?.classList.add('hidden');
  TAB_VIEWS.forEach((tab) => document.getElementById(`${tab}-view`)?.classList.add('hidden'));
  document.querySelectorAll('.tab-view, .view').forEach((el) => el.classList.add('hidden'));
}

window.electronAPI?.onBanDetected?.((ban) => {
  showBanOverlay(ban?.ban || ban);
});

/* A startup ban check can complete before this script subscribes to the event,
   so ask the main process for anything it queued while the page was loading. */
window.electronAPI?.pendingBan?.().then((ban) => {
  if (ban) showBanOverlay(ban.ban || ban);
}).catch(() => {});
