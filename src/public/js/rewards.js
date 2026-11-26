/* Daily rewards — the launcher face of the store wallet. The store backend
   keeps the claim itself (one credit per UTC day), so this file only renders
   the status and reflects what the server says. */

let rewardIdentity = null;
let rewardData = null;
let rewardsLoading = false;
let rewardClaiming = false;

function rewardEsc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function rewardNumber(value) {
  return Number(value || 0).toLocaleString();
}

async function ensureRewardIdentity() {
  if (rewardIdentity?.uuid) return rewardIdentity;
  if (typeof friendsState !== 'undefined' && friendsState?.uuid) {
    rewardIdentity = { uuid: friendsState.uuid, name: friendsState.name };
    return rewardIdentity;
  }
  const session = await window.electronAPI?.sessionGet?.();
  if (!session?.uuid) return null;
  rewardIdentity = { uuid: String(session.uuid).toLowerCase(), name: session.username };
  return rewardIdentity;
}

/* ---------- top-bar chip ---------- */

function renderRewardChip() {
  const chip = document.getElementById('reward-chip');
  if (!chip) return;

  const coins = document.getElementById('reward-chip-coins');
  const dot = document.getElementById('reward-claim-dot');
  const ready = Boolean(rewardData?.canClaim);

  if (coins) coins.textContent = rewardData ? rewardNumber(rewardData.coins) : '—';
  chip.classList.toggle('has-claim', ready);
  dot?.classList.toggle('hidden', !ready);
  document.getElementById('account-reward-dot')?.classList.toggle('hidden', !ready);
  chip.title = ready
    ? `Daily reward ready — +${rewardNumber(rewardData?.rewardForNextClaim)} coins`
    : 'Daily rewards and wallet';
}

async function refreshDailyRewards() {
  if (rewardsLoading) return;
  rewardsLoading = true;
  try {
    const identity = await ensureRewardIdentity();
    if (!identity) {
      rewardData = null;
      renderRewardChip();
      renderRewardsModal();
      return;
    }
    const result = await window.electronAPI?.getDailyReward?.({ uuid: identity.uuid });
    rewardData = result?.ok ? result : { error: result?.error || 'The store is unreachable right now.' };
  } catch (err) {
    rewardData = { error: 'The store is unreachable right now.' };
  } finally {
    rewardsLoading = false;
    renderRewardChip();
    renderRewardsModal();
  }
}

/* ---------- modal ---------- */

function renderRewardsModal() {
  const modal = document.getElementById('rewards-modal');
  if (!modal || modal.classList.contains('hidden')) return;

  const subtitle = document.getElementById('reward-subtitle');
  const balance = document.getElementById('reward-balance');
  const streak = document.getElementById('reward-streak');
  const days = document.getElementById('reward-days');
  const claim = document.getElementById('reward-claim-btn');
  const status = document.getElementById('reward-status');

  if (!rewardData || rewardData.error) {
    if (subtitle) subtitle.textContent = 'The store could not be reached.';
    if (balance) balance.textContent = '—';
    if (streak) streak.textContent = '0';
    if (days) days.innerHTML = `<p class="col-span-7 text-[11px] text-white/30 py-2">${rewardEsc(rewardData?.error || 'Rewards are unavailable right now.')}</p>`;
    if (claim) {
      claim.disabled = true;
      claim.className = 'w-full h-10 rounded-lg font-semibold text-[12px] bg-white/[0.06] text-white/30 cursor-not-allowed';
      claim.textContent = 'Store offline';
    }
    if (status) status.textContent = 'Start the content server and try again.';
    return;
  }

  if (subtitle) {
    subtitle.textContent = rewardData.claimedToday
      ? `Day ${Math.max(1, Math.min(rewardData.streak, rewardData.maxDay))} of ${rewardData.maxDay} collected.`
      : `Collect ${rewardNumber(rewardData.rewardForNextClaim)} coins for today.`;
  }
  if (balance) balance.textContent = rewardNumber(rewardData.coins);
  if (streak) streak.textContent = String(rewardData.streak || 0);

  if (days) {
    const track = Array.isArray(rewardData.days) && rewardData.days.length
      ? rewardData.days
      : Array.from({ length: rewardData.maxDay || 7 }, (_, i) => ({ day: i + 1, coins: 0 }));
    days.innerHTML = track.map((entry) => {
      const classes = ['reward-day'];
      if (entry.claimed) classes.push('is-claimed');
      if (entry.today && !entry.claimed) classes.push('is-today');
      const check = entry.claimed
        ? '<svg class="w-3 h-3 text-[#7ad48a]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>'
        : `<span class="text-[11px] font-semibold ${entry.today ? 'text-white' : 'text-white/65'}">+${rewardNumber(entry.coins)}</span>`;
      return `<div class="${classes.join(' ')}">
        <span class="text-[9px] font-medium uppercase tracking-wide ${entry.today ? 'text-[#f7d774]' : 'text-white/30'}">Day ${entry.day}</span>
        ${check}
      </div>`;
    }).join('');
  }

  if (claim) {
    const enabled = rewardData.canClaim && !rewardClaiming;
    claim.disabled = !enabled;
    if (rewardClaiming) {
      claim.className = 'w-full h-10 rounded-lg font-semibold text-[12px] bg-[#f7d774]/20 text-[#f7d774] cursor-progress';
      claim.textContent = 'Collecting…';
    } else if (rewardData.canClaim) {
      claim.className = 'w-full h-10 rounded-lg font-semibold text-[12px] bg-[#f7d774] hover:bg-[#ffe28f] text-[#3a2703] transition-colors cursor-pointer';
      claim.textContent = `Claim +${rewardNumber(rewardData.rewardForNextClaim)} coins`;
    } else {
      claim.className = 'w-full h-10 rounded-lg font-semibold text-[12px] bg-white/[0.06] text-white/35 cursor-not-allowed';
      claim.textContent = rewardData.enabled === false ? 'Daily rewards are off' : 'Come back tomorrow';
    }
  }

  if (status) {
    if (rewardData.claimedToday) {
      status.textContent = `Next claim unlocks at midnight UTC (${rewardResetLabel(rewardData.resetsAt)} your time).`;
    } else {
      status.textContent = 'One claim per day. Missing a day restarts the streak.';
    }
  }
}

function rewardResetLabel(iso) {
  if (!iso) return 'midnight UTC';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'midnight UTC';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function openRewards() {
  const modal = document.getElementById('rewards-modal');
  if (!modal) return;
  closeContentMenu?.();
  toggleAccountMenu?.(false);
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  renderRewardsModal();
  refreshDailyRewards();
}

function closeRewards() {
  const modal = document.getElementById('rewards-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

async function claimDailyReward() {
  if (rewardClaiming || !rewardData?.canClaim) return;
  const identity = await ensureRewardIdentity();
  if (!identity) {
    showToast('Sign in to collect daily rewards.', 'info');
    return;
  }

  rewardClaiming = true;
  renderRewardsModal();
  try {
    const result = await window.electronAPI?.claimDailyReward?.({ uuid: identity.uuid });
    if (!result?.ok) {
      showToast(result?.error || 'Could not collect the reward.', 'error');
      return;
    }

    rewardData = result;
    if (result.claimed) {
      showToast(`+${rewardNumber(result.reward)} coins collected. Balance: ${rewardNumber(result.coins)}.`, 'success');
    } else {
      showToast('This reward was already collected today.', 'info');
    }
    renderRewardChip();
    renderRewardsModal();
  } catch (err) {
    showToast('Could not collect the reward.', 'error');
  } finally {
    rewardClaiming = false;
    renderRewardsModal();
  }
}

/* ---------- lifecycle ---------- */

document.addEventListener('DOMContentLoaded', () => {
  // The chip lives in the header; wait a tick so the dashboard chrome and the
  // saved session have both been applied.
  setTimeout(() => {
    if (document.getElementById('dashboard-utilities')?.classList.contains('hidden')) return;
    refreshDailyRewards();
  }, 900);

  // A long session still gets the next day's claim without a restart.
  setInterval(() => {
    const modal = document.getElementById('rewards-modal');
    const open = modal && !modal.classList.contains('hidden');
    if (!open && document.getElementById('dashboard-utilities')?.classList.contains('hidden')) return;
    refreshDailyRewards();
  }, 5 * 60 * 1000);
});
