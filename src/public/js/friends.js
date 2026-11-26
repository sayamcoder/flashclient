/* Friends tab — the launcher side of the content server's friends and chat API.
   Identity is the Minecraft UUID: offline accounts use their offline UUID, so no
   sign-up step is needed and the list follows the same account everywhere. */

let friendsState = {
  uuid: null,
  name: null,
  friends: [],
  incoming: [],
  outgoing: [],
  online: [],
  players: [],
  invites: []
};

let friendsPollTimer = null;
let chatPeer = null;
let chatPeerName = '';
let chatLastId = 0;
let chatPollTimer = null;
let addFriendFound = null;
let friendRequestBusy = false;
let chatLoading = false;

function friendEsc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function friendInitial(name) {
  return friendEsc((name || '?').trim().charAt(0).toUpperCase() || '?');
}

function friendAvatarTag(name, size) {
  return `<img data-friend-avatar="${friendEsc(name)}" src="${SKIN_FALLBACK}" alt=""
     onerror="skinFallback(this)" onload="friendAvatarFill(this)"
     class="${size} rounded-md bg-white/[0.06] ring-1 ring-white/10 shrink-0 pixelated" />`;
}

/* Heads are cut from the account's skin, and the same name may show up twice,
   so the fill runs once per image after the markup is in the document. */
function friendAvatarFill(img) {
  const name = img.dataset.friendAvatar;
  if (!name || img.dataset.filled === '1') return;
  img.dataset.filled = '1';
  headForUsername(name, 64).then((head) => {
    if (head) img.src = head;
  }).catch(() => {});
}

function friendsOnlineSet() {
  return new Set((friendsState.online || []).map((id) => String(id).toLowerCase()));
}

function friendIsOnline(uuid) {
  return friendsOnlineSet().has(String(uuid || '').toLowerCase());
}

/* ---------- loading ---------- */

async function ensureFriendIdentity() {
  if (friendsState.uuid) return friendsState;
  const session = await window.electronAPI?.sessionGet?.();
  if (!session?.uuid || !session?.username) return null;
  friendsState.uuid = String(session.uuid).toLowerCase();
  friendsState.name = session.username;
  return friendsState;
}

async function loadFriends() {
  const list = document.getElementById('friends-list');
  if (!list) return;
  if (!window.electronAPI?.syncFriends) {
    list.innerHTML = '<p class="text-[11px] text-white/30 px-2">Friends are managed by the desktop app.</p>';
    return;
  }

  const identity = await ensureFriendIdentity();
  if (!identity) {
    list.innerHTML = '<p class="text-[11px] text-white/30 px-2">Sign in to use friends.</p>';
    return;
  }

  try {
    const [result, playersResult] = await Promise.all([
      window.electronAPI.syncFriends({
        uuid: identity.uuid,
        name: identity.name
      }),
      window.electronAPI.getOnlinePlayers
        ? window.electronAPI.getOnlinePlayers().catch(() => null)
        : Promise.resolve(null)
    ]);

    if (!result?.ok) {
      list.innerHTML = `<p class="text-[11px] text-white/30 px-2">${friendEsc(result?.error || 'The friends service is unreachable.')}</p>`;
      document.getElementById('friends-subtitle').textContent = 'Could not reach the friends server';
      return;
    }

    const you = result.you || {};
    friendsState.friends = you.friends || [];
    friendsState.incoming = you.incoming || [];
    friendsState.outgoing = you.outgoing || [];
    friendsState.online = result.online || [];
    friendsState.players = playersResult?.players || [];
    friendsState.invites = result.invites || [];

    renderFriends();
    startFriendsPolling();
  } catch (err) {
    list.innerHTML = '<p class="text-[11px] text-white/30 px-2">The friends service is unreachable.</p>';
  }
}

function startFriendsPolling() {
  if (friendsPollTimer) return;
  // Presence is a heartbeat; ten seconds keeps the list fresh without hammering
  // the server the way a one-second poll would.
  friendsPollTimer = setInterval(() => {
    const view = document.getElementById('friends-view');
    if (!view || view.classList.contains('hidden')) return;
    refreshFriendsQuiet();
  }, 10000);
}

async function refreshFriendsQuiet() {
  if (!friendsState.uuid) return;
  try {
    const [result, playersResult] = await Promise.all([
      window.electronAPI.syncFriends({
        uuid: friendsState.uuid,
        name: friendsState.name
      }),
      window.electronAPI.getOnlinePlayers
        ? window.electronAPI.getOnlinePlayers().catch(() => null)
        : Promise.resolve(null)
    ]);
    if (!result?.ok) return;
    const you = result.you || {};
    friendsState.friends = you.friends || [];
    friendsState.incoming = you.incoming || [];
    friendsState.outgoing = you.outgoing || [];
    friendsState.online = result.online || [];
    friendsState.players = playersResult?.players || [];
    renderFriends();
  } catch (err) {
    /* keep the last good list */
  }
}

/* ---------- rendering ---------- */

function friendRow(friend) {
  const online = friendIsOnline(friend.uuid);
  const active = chatPeer === friend.uuid;
  const frame = active ? 'bg-white/[0.07] border-white/20' : 'bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.05]';

  return `
    <button type="button" data-friend-uuid="${friendEsc(friend.uuid)}" onclick="openFriendChat(this.dataset.friendUuid)" 
            class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg border ${frame} text-left transition-colors cursor-pointer">
      <span class="relative shrink-0">
        ${friendAvatarTag(friend.name, 'w-7 h-7')}
        <span class="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-[#09090b] ${online ? 'bg-[#5ec36a]' : 'bg-white/25'}"></span>
      </span>
      <span class="min-w-0 flex-1">
        <span class="block text-[12px] font-medium text-white/90 truncate">${friendEsc(friend.name)}</span>
        <span class="block text-[10px] text-white/35 truncate">${online ? 'Online' : 'Offline'}</span>
      </span>
      <span onclick="event.stopPropagation(); confirmRemoveFriend(this.closest('button').dataset.friendUuid)" title="Remove friend"
            class="w-6 h-6 flex items-center justify-center rounded text-white/20 hover:text-[#ef8b8b] hover:bg-white/[0.06] transition-colors cursor-pointer">
        <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </span>
    </button>`;
}

function requestRow(request) {
  return `
    <div class="flex items-center gap-2 px-2.5 py-2 rounded-lg border border-white/[0.06] bg-white/[0.02]">
      ${friendAvatarTag(request.name, 'w-7 h-7')}
      <span class="min-w-0 flex-1">
        <span class="block text-[12px] font-medium text-white/90 truncate">${friendEsc(request.name)}</span>
        <span class="block text-[10px] text-white/35">wants to be friends</span>
      </span>
      <button type="button" data-friend-uuid="${friendEsc(request.uuid)}" onclick="acceptFriend(this.dataset.friendUuid)" title="Accept"
              class="w-6 h-6 flex items-center justify-center rounded bg-[#4cbb5e]/20 text-[#7ad48a] hover:bg-[#4cbb5e]/30 transition-colors cursor-pointer">
        <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>
      </button>
      <button type="button" data-friend-uuid="${friendEsc(request.uuid)}" onclick="declineFriend(this.dataset.friendUuid)" title="Decline"
              class="w-6 h-6 flex items-center justify-center rounded text-white/30 hover:text-[#ef8b8b] hover:bg-white/[0.06] transition-colors cursor-pointer">
        <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    </div>`;
}

function renderFriendRequests() {
  const section = document.getElementById('friend-requests-section');
  const list = document.getElementById('friend-requests-list');
  if (!section || !list) return;

  const requests = friendsState.incoming || [];
  // Pending requests you sent are invisible to you on purpose; only incoming
  // ones need a decision, so the section stays out of the way when it is empty.
  section.classList.toggle('hidden', !requests.length);
  list.innerHTML = requests.map(requestRow).join('');
}

function renderFriends() {
  renderFriendRequests();

  const list = document.getElementById('friends-list');
  if (list) {
    list.innerHTML = friendsState.friends.length
      ? friendsState.friends.map(friendRow).join('')
      : '<p class="text-[11px] text-white/30 px-2 py-3">No friends yet. Add someone by username.</p>';
  }

  const onlineSection = document.getElementById('online-players-section');
  const onlineList = document.getElementById('online-players-list');
  if (onlineSection && onlineList) {
    const friendIds = new Set(friendsState.friends.map((f) => f.uuid.toLowerCase()));
    const others = (friendsState.players || [])
      .filter((player) => {
        const id = String(player.uuid || '').toLowerCase();
        return id && id !== friendsState.uuid && !friendIds.has(id);
      })
      .slice(0, 12);

    onlineSection.classList.toggle('hidden', !others.length);
    onlineList.innerHTML = others.map((player) => `
      <div class="px-2.5 py-1.5 rounded-lg bg-white/[0.02] border border-white/[0.05] flex items-center justify-between gap-2">
        <span class="text-[11px] text-white/55 truncate">${friendEsc(player.name)}</span>
        <button type="button" data-player-uuid="${friendEsc(player.uuid)}" data-player-name="${friendEsc(player.name)}" onclick="addOnlinePlayer(this.dataset.playerUuid, this.dataset.playerName)"
                class="h-6 px-2 rounded bg-white/[0.06] hover:bg-white/[0.1] text-[10px] font-medium text-white/70 transition-colors cursor-pointer">Add friend</button>
      </div>`).join('');
  }

  const subtitle = document.getElementById('friends-subtitle');
  if (subtitle) {
    const onlineCount = friendsState.friends.filter((f) => friendIsOnline(f.uuid)).length;
    subtitle.textContent = friendsState.friends.length
      ? `${friendsState.friends.length} friend${friendsState.friends.length === 1 ? '' : 's'} · ${onlineCount} online`
      : 'Connect with other players';
  }
}

/* ---------- requests ---------- */

function openAddFriendModal() {
  const modal = document.getElementById('add-friend-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  document.getElementById('add-friend-error')?.classList.add('hidden');
  document.getElementById('add-friend-result')?.classList.add('hidden');
  addFriendFound = null;
  const input = document.getElementById('add-friend-input');
  if (input) {
    input.value = '';
    input.focus();
  }
}

function closeAddFriendModal() {
  const modal = document.getElementById('add-friend-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

async function submitAddFriend(event) {
  event?.preventDefault?.();
  if (friendRequestBusy) return;

  const input = document.getElementById('add-friend-input');
  const error = document.getElementById('add-friend-error');
  const found = document.getElementById('add-friend-result');
  const name = (input?.value || '').trim();

  error?.classList.add('hidden');
  found?.classList.add('hidden');

  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
    if (error) {
      error.textContent = 'Use 3-16 letters, numbers or underscores.';
      error.classList.remove('hidden');
    }
    return;
  }

  if (name.toLowerCase() === String(friendsState.name || '').toLowerCase()) {
    if (error) {
      error.textContent = 'You cannot add yourself.';
      error.classList.remove('hidden');
    }
    return;
  }

  friendRequestBusy = true;
  const button = document.getElementById('add-friend-submit');
  const label = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = 'Sending…';
  }

  try {
    // Look the name up first so an unknown player gets a clear answer instead
    // of a request that silently goes nowhere.
    const lookup = await window.electronAPI.lookupFriend({ name });
    const player = lookup?.player;
    if (!player?.uuid) {
      if (error) {
        error.textContent = "That player isn't known yet. They have to open FlashClient once.";
        error.classList.remove('hidden');
      }
      return;
    }

    const result = await window.electronAPI.sendFriendRequest({
      uuid: friendsState.uuid,
      name: friendsState.name,
      targetUuid: player.uuid,
      targetName: player.name
    });

    if (!result?.ok) {
      if (error) {
        error.textContent = result?.error || 'Could not send that request.';
        error.classList.remove('hidden');
      }
      return;
    }

    friendsState.friends = result.you?.friends || friendsState.friends;
    friendsState.incoming = result.you?.incoming || [];
    friendsState.outgoing = result.you?.outgoing || [];
    friendsState.online = result.online || friendsState.online;

    closeAddFriendModal();
    renderFriends();

    if (result.status === 'friends') showToast(`${player.name} is now your friend.`, 'success');
    else showToast(`Friend request sent to ${player.name}.`, 'success');
  } finally {
    friendRequestBusy = false;
    if (button) {
      button.disabled = false;
      button.textContent = label || 'Send Request';
    }
  }
}

async function addOnlinePlayer(uuid, name) {
  if (!uuid || !name) return;
  const result = await window.electronAPI.sendFriendRequest({
    uuid: friendsState.uuid,
    name: friendsState.name,
    targetUuid: uuid,
    targetName: name
  });
  if (!result?.ok) {
    showToast(result?.error || 'Could not send that request.', 'error');
    return;
  }
  friendsState.friends = result.you?.friends || friendsState.friends;
  friendsState.outgoing = result.you?.outgoing || [];
  renderFriends();
  showToast(result.status === 'friends' ? 'You are now friends.' : 'Friend request sent.', 'success');
}

async function acceptFriend(uuid) {
  if (!uuid) return;
  const result = await window.electronAPI.acceptFriendRequest({
    uuid: friendsState.uuid,
    name: friendsState.name,
    targetUuid: uuid
  });
  if (!result?.ok) {
    showToast(result?.error || 'Could not accept that request.', 'error');
    return;
  }
  friendsState.friends = result.you?.friends || friendsState.friends;
  friendsState.incoming = result.you?.incoming || [];
  friendsState.outgoing = result.you?.outgoing || [];
  friendsState.online = result.online || friendsState.online;
  renderFriends();
  showToast('Friend request accepted.', 'success');
}

async function declineFriend(uuid) {
  if (!uuid) return;
  const result = await window.electronAPI.declineFriendRequest({
    uuid: friendsState.uuid,
    name: friendsState.name,
    targetUuid: uuid
  });
  if (!result?.ok) {
    showToast(result?.error || 'Could not decline that request.', 'error');
    return;
  }
  friendsState.friends = result.you?.friends || friendsState.friends;
  friendsState.incoming = result.you?.incoming || [];
  friendsState.outgoing = result.you?.outgoing || [];
  renderFriends();
}

let removeFriendArmed = null;

function confirmRemoveFriend(uuid) {
  const friend = friendsState.friends.find((f) => f.uuid === uuid);
  if (!friend) return;

  if (removeFriendArmed !== uuid) {
    removeFriendArmed = uuid;
    showToast(`Press × again to remove ${friend.name}.`, 'info');
    setTimeout(() => { if (removeFriendArmed === uuid) removeFriendArmed = null; }, 4000);
    return;
  }
  removeFriendArmed = null;
  removeFriend(uuid);
}

async function removeFriend(uuid) {
  const friend = friendsState.friends.find((f) => f.uuid === uuid);
  const result = await window.electronAPI.removeFriend({
    uuid: friendsState.uuid,
    name: friendsState.name,
    targetUuid: uuid
  });
  if (!result?.ok) {
    showToast(result?.error || 'Could not remove that friend.', 'error');
    return;
  }
  friendsState.friends = result.you?.friends || friendsState.friends;
  renderFriends();
  if (chatPeer === uuid) closeChat();
  showToast(`${friend?.name || 'Friend'} removed.`, 'info');
}

/* ---------- chat ---------- */

function openFriendChat(uuid) {
  const friend = friendsState.friends.find((f) => f.uuid === uuid);
  if (!friend) return;

  chatPeer = friend.uuid;
  chatPeerName = friend.name;
  chatLastId = 0;

  const header = document.getElementById('friend-chat-header');
  const messages = document.getElementById('chat-messages');
  const inputArea = document.getElementById('chat-input-area');
  const empty = document.getElementById('chat-empty-state');

  header?.classList.remove('hidden');
  messages?.classList.remove('hidden');
  inputArea?.classList.remove('hidden');
  empty?.classList.add('hidden');

  const nameEl = document.getElementById('chat-friend-name');
  if (nameEl) nameEl.textContent = friend.name;
  const statusEl = document.getElementById('chat-friend-status');
  if (statusEl) statusEl.textContent = friendIsOnline(friend.uuid) ? 'Online' : 'Offline';

  const avatar = document.getElementById('chat-friend-avatar');
  if (avatar) {
    avatar.src = SKIN_FALLBACK;
    headForUsername(friend.name, 64).then((head) => {
      if (head && chatPeer === friend.uuid) avatar.src = head;
    }).catch(() => {});
  }

  const list = document.getElementById('chat-messages-list');
  if (list) list.innerHTML = '<p class="text-[11px] text-white/25 px-1">Loading messages…</p>';

  renderFriends();
  loadChatHistory();
  startChatPolling();
}

function closeChat() {
  chatPeer = null;
  chatPeerName = '';
  chatLastId = 0;
  stopChatPolling();

  document.getElementById('friend-chat-header')?.classList.add('hidden');
  document.getElementById('chat-messages')?.classList.add('hidden');
  document.getElementById('chat-input-area')?.classList.add('hidden');
  document.getElementById('chat-empty-state')?.classList.remove('hidden');
  renderFriends();
}

function startChatPolling() {
  stopChatPolling();
  chatPollTimer = setInterval(loadChatHistory, 3000);
}

function stopChatPolling() {
  if (chatPollTimer) {
    clearInterval(chatPollTimer);
    chatPollTimer = null;
  }
}

function chatMessageRow(message) {
  const mine = String(message.from).toLowerCase() === String(friendsState.uuid).toLowerCase();
  const time = new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `
    <div class="flex ${mine ? 'justify-end' : 'justify-start'}">
      <div class="max-w-[75%]">
        <div class="px-3 py-1.5 rounded-lg text-[12px] leading-relaxed ${mine ? 'bg-white text-[#0b0b0e]' : 'bg-white/[0.07] text-white/85'}">
          ${friendEsc(message.text)}
        </div>
        <p class="text-[10px] text-white/25 mt-0.5 ${mine ? 'text-right' : ''}">${time}</p>
      </div>
    </div>`;
}

async function loadChatHistory() {
  if (!chatPeer || chatLoading) return;
  const peer = chatPeer;
  chatLoading = true;

  try {
    const result = await window.electronAPI.getChatHistory({
      uuid: friendsState.uuid,
      peerUuid: peer,
      since: chatLastId
    });
    if (peer !== chatPeer) return;

    if (!result?.ok) {
      if (chatLastId === 0) {
        const list = document.getElementById('chat-messages-list');
        if (list) list.innerHTML = `<p class="text-[11px] text-white/25 px-1">${friendEsc(result?.error || 'Chat is unavailable right now.')}</p>`;
      }
      return;
    }

    const messages = result.messages || [];
    if (!messages.length) {
      if (chatLastId === 0) {
        const list = document.getElementById('chat-messages-list');
        if (list) list.innerHTML = '<p class="text-[11px] text-white/25 px-1">No messages yet. Say hello.</p>';
      }
      return;
    }

    const list = document.getElementById('chat-messages-list');
    if (!list) return;

    if (chatLastId === 0) list.innerHTML = '';
    list.insertAdjacentHTML('beforeend', messages.map(chatMessageRow).join(''));
    chatLastId = Math.max(chatLastId, ...messages.map((m) => m.id));

    const scroller = document.getElementById('chat-messages');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  } catch (err) {
    if (chatLastId === 0) {
      const list = document.getElementById('chat-messages-list');
      if (list) list.innerHTML = '<p class="text-[11px] text-white/25 px-1">Chat is unavailable right now.</p>';
    }
  } finally {
    chatLoading = false;
  }
}

async function sendChatMessage(event) {
  event?.preventDefault?.();
  if (!chatPeer) return;

  const input = document.getElementById('chat-message-input');
  const text = (input?.value || '').trim();
  if (!text) return;

  if (input) input.value = '';

  const result = await window.electronAPI.sendChatMessage({
    uuid: friendsState.uuid,
    name: friendsState.name,
    targetUuid: chatPeer,
    text
  });

  if (!result?.ok) {
    showToast(result?.error || 'Could not send that message.', 'error');
    if (input) input.value = text;
    return;
  }

  await loadChatHistory();
}

/* A world invite needs a code that only a running hosted world has; until the
   launcher can host one, this points the player at the in-game flow. */
function inviteToGame() {
  showToast('Open the world in Minecraft, then send the join code from the in-game friends list.', 'info');
}

document.addEventListener('DOMContentLoaded', () => {
  window.addEventListener('beforeunload', () => {
    if (friendsPollTimer) clearInterval(friendsPollTimer);
    stopChatPolling();
  });
});