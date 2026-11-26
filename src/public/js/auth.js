function openCrackedModal() {
  const modal = document.getElementById('cracked-modal');
  if (modal) {
    modal.style.display = 'flex';
    document.getElementById('cracked-input')?.focus();
  }
}

function closeCrackedModal() {
  const modal = document.getElementById('cracked-modal');
  if (modal) modal.style.display = 'none';
}

let debounceTimer;
function handleAvatarPreview(val) {
  clearTimeout(debounceTimer);
  const avatar = document.getElementById('avatar-preview');
  const spinner = document.getElementById('avatar-loading');
  const statusLabel = document.getElementById('skin-status-label');
  const username = val.trim();
  if (!avatar) return;

  if (username.length >= 3) {
    spinner?.classList.remove('hidden');
    if (statusLabel) statusLabel.textContent = 'Fetching skin…';

    debounceTimer = setTimeout(async () => {
      // The head is cut out of the account's own skin texture, so the preview
      // and the chip in the bar are always the same pixels.
      const head = await headForUsername(username, 48);
      if (head) {
        avatar.src = head;
        if (statusLabel) statusLabel.textContent = 'Skin found';
      } else if (statusLabel) {
        statusLabel.textContent = 'No skin found';
      }
      spinner?.classList.add('hidden');
    }, 400);
  } else {
    spinner?.classList.add('hidden');
    if (statusLabel) statusLabel.textContent = 'Skin preview';
  }
}

async function handleCrackedSubmit(e) {
  e.preventDefault();
  const input = document.getElementById('cracked-input');
  const errorMsg = document.getElementById('cracked-error');
  const username = input.value.trim();

  if (!/^[a-zA-Z0-9_]{3,16}$/.test(username)) {
    errorMsg?.classList.remove('hidden');
    showToast('Usernames are 3-16 letters, numbers or underscores.', 'error');
    return;
  }

  errorMsg?.classList.add('hidden');

  // Offline accounts launch with Minecraft's own offline mode: an offline UUID
  // and token "0". Nothing skips Mojang auth — there is simply no session to have.
  await window.electronAPI?.loginCracked?.(username);

  const avatar = await headForUsername(username, 64);
  const userSession = { username, type: 'cracked', avatar: avatar || SKIN_FALLBACK };
  localStorage.setItem('flash_session', JSON.stringify(userSession));

  closeCrackedModal();
  showToast(`Signed in as ${username}.`, 'success');
  enterDashboard(userSession);
}

async function handleMicrosoftLogin() {
  const btn = document.getElementById('microsoft-login-btn');
  if (!btn || !window.electronAPI) return;

  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span>Waiting for Microsoft…</span>`;

  try {
    const res = await window.electronAPI.loginWithMicrosoft();
    if (res?.success) {
      const head = await headForUsername(res.username, 64);
      const userSession = {
        username: res.username,
        type: 'microsoft',
        avatar: head || SKIN_FALLBACK
      };
      localStorage.setItem('flash_session', JSON.stringify(userSession));
      showToast(`Signed in as ${res.username}.`, 'success');
      enterDashboard(userSession);
    } else {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
      showToast(res?.message || 'Sign-in cancelled.', 'error');
    }
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
    showToast('Could not reach Microsoft. Try again.', 'error');
  }
}

function handleLogout() {
  window.electronAPI?.logout?.();
  localStorage.removeItem('flash_session');
  setChromeVisible(false);
  document.getElementById('account-menu')?.classList.add('hidden');
  setBackdrop(true);

  // The friends tab is account-scoped, so its cached identity must not survive
  // a sign-out on a shared PC.
  if (typeof friendsState !== 'undefined') {
    friendsState = { uuid: null, name: null, friends: [], incoming: [], outgoing: [], online: [], players: [], invites: [] };
  }
  if (typeof closeChat === 'function') closeChat();
  if (typeof closeRewards === 'function') closeRewards();
  if (typeof rewardIdentity !== 'undefined') {
    rewardIdentity = null;
    rewardData = null;
    rewardClaiming = false;
    renderRewardChip?.();
  }

  ['play', 'profiles', 'mods', 'shaders', 'resourcepacks', 'skins', 'friends', 'servers', 'settings'].forEach(tab => {
    document.getElementById(`${tab}-view`)?.classList.add('hidden');
    document.getElementById(`${tab}-view`)?.classList.remove('flex');
  });

  document.getElementById('auth-view')?.classList.remove('hidden');
  showToast('Logged out.', 'info');
}
