/* The Cosmetics tab edits the same file the in-game locker uses, so whatever is
   picked here is what the client wears on the next launch. The catalog comes
   from the content server; paid items need to be owned before they can be worn,
   exactly like in-game. */

let cosmeticItems = [];
let cosmeticSelection = { wings: '', cape: '', hat: '' };
let cosmeticStore = '';
let cosmeticSlot = 'wings';
let cosmeticProfileId = null;
let cosmeticsLoading = false;

const COSMETIC_SLOT_LABEL = { wings: 'wings', cape: 'capes', hat: 'hats' };

function cosmeticEsc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function setCosmeticSlot(slot) {
  if (!COSMETIC_SLOT_LABEL[slot]) return;
  cosmeticSlot = slot;
  document.querySelectorAll('.cosmetic-tab').forEach((btn) => {
    const active = btn.dataset.cosmeticSlot === slot;
    btn.className = `cosmetic-tab px-2.5 py-1 text-[11px] font-medium rounded cursor-pointer ${
      active ? 'text-white bg-white/10' : 'text-white/40 hover:text-white'
    }`;
  });
  renderCosmeticsGrid();
}

async function loadCosmetics() {
  const grid = document.getElementById('cosmetics-grid');
  if (!grid) return;
  if (cosmeticsLoading) return;

  const profile = typeof activeProfile === 'function' ? activeProfile() : null;
  if (!profile) return;
  cosmeticProfileId = profile.id;

  const note = document.getElementById('cosmetics-note');
  if (note) note.textContent = `Saving for ${profile.name} — launch it to wear the pick.`;

  cosmeticsLoading = true;
  grid.innerHTML = '<p class="text-[11px] text-white/30 col-span-full">Loading cosmetics…</p>';
  try {
    const result = await window.electronAPI?.getCosmetics?.({ profileId: profile.id });
    if (!result?.success) {
      grid.innerHTML = `<p class="text-[11px] text-white/30 col-span-full">${cosmeticEsc(result?.error || 'The cosmetic catalog is unreachable.')}</p>`;
      return;
    }
    cosmeticItems = result.items || [];
    cosmeticSelection = result.selection || { wings: '', cape: '', hat: '' };
    cosmeticStore = result.store || '';

    // Wings are the first tab, but a catalog can ship without them; land on a
    // slot that actually has something to pick instead of an empty grid.
    const filled = ['wings', 'hat', 'cape'].find((slot) => cosmeticItems.some((item) => item.type === slot));
    if (filled && !cosmeticItems.some((item) => item.type === cosmeticSlot)) {
      setCosmeticSlot(filled);
    } else {
      renderCosmeticsGrid();
    }
    syncCosmeticPreview();
    resolvePreviewSkin();
  } catch (err) {
    grid.innerHTML = '<p class="text-[11px] text-white/30 col-span-full">The cosmetic catalog is unreachable.</p>';
  } finally {
    cosmeticsLoading = false;
  }
}

function cosmeticCard(item, selected) {
  const frame = selected ? 'border-white/35 bg-white/[0.07]' : 'border-white/[0.07] bg-white/[0.03] hover:bg-white/[0.06]';
  const badge = selected
    ? '<span class="text-[10px] font-semibold text-white">Worn</span>'
    : item.locked
      ? '<span class="text-[10px] text-white/35">In store</span>'
      : `<span class="text-[10px] text-white/30">${item.price > 0 ? 'Owned' : 'Free'}</span>`;

  const art = item.preview
    ? `<img src="${cosmeticEsc(item.preview)}" alt="${cosmeticEsc(item.name)}" loading="lazy"
            class="max-h-full max-w-full object-contain drop-shadow-md"
            onerror="this.style.visibility='hidden'" />`
    : '<span class="text-[11px] text-white/25">No preview</span>';

  return `
    <div onclick="toggleCosmetic('${item.id}')"
         class="group relative border ${frame} rounded-lg p-2.5 flex flex-col cursor-pointer transition-colors"
         title="${cosmeticEsc(item.description || item.name)}">
      <div class="h-[92px] flex items-center justify-center mb-2">${art}</div>
      <div class="w-full pt-2 border-t border-white/[0.06]">
        <h4 class="text-[11px] font-medium text-white/85 truncate">${cosmeticEsc(item.name)}</h4>
        <div class="flex items-center justify-between mt-1 gap-2">
          <span class="text-[10px] text-white/30 truncate capitalize">${cosmeticEsc(item.rarity)}</span>
          ${badge}
        </div>
      </div>
    </div>`;
}

function renderCosmeticsGrid() {
  const grid = document.getElementById('cosmetics-grid');
  if (!grid) return;

  const ofSlot = cosmeticItems.filter((item) => item.type === cosmeticSlot);
  const current = cosmeticSelection[cosmeticSlot] || '';
  const noneSelected = !current;
  const noneFrame = noneSelected ? 'border-white/35 bg-white/[0.07]' : 'border-white/[0.07] bg-white/[0.03] hover:bg-white/[0.06]';

  grid.innerHTML = `
    <div onclick="toggleCosmetic('')"
         class="border ${noneFrame} rounded-lg p-2.5 flex flex-col cursor-pointer transition-colors">
      <div class="h-[92px] flex items-center justify-center mb-2">
        <svg class="w-6 h-6 text-white/20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <circle cx="12" cy="12" r="9"></circle><line x1="6.5" y1="17.5" x2="17.5" y2="6.5"></line>
        </svg>
      </div>
      <div class="w-full pt-2 border-t border-white/[0.06]">
        <h4 class="text-[11px] font-medium text-white/85">None</h4>
        <div class="flex items-center justify-between mt-1">
          <span class="text-[10px] text-white/30">Bare</span>
          ${noneSelected ? '<span class="text-[10px] font-semibold text-white">Worn</span>' : ''}
        </div>
      </div>
    </div>
    ${ofSlot.map((item) => cosmeticCard(item, item.id === current)).join('')}
    ${ofSlot.length ? '' : '<p class="text-[11px] text-white/30 col-span-full py-2">No ' + COSMETIC_SLOT_LABEL[cosmeticSlot] + ' in the catalog yet.</p>'}
  `;
}

async function toggleCosmetic(id) {
  if (!cosmeticProfileId) return;
  const item = id ? cosmeticItems.find((entry) => entry.id === id) : null;

  if (item?.locked) {
    if (cosmeticStore) window.open(cosmeticStore);
    showToast(`"${item.name}" is not on this account yet — pick it up in the store.`, 'info');
    return;
  }

  // The slot follows the item itself, never the tab that happens to be open.
  const slot = item ? item.type : cosmeticSlot;
  const next = (cosmeticSelection[slot] || '') === id ? '' : id;
  try {
    const result = await window.electronAPI?.saveCosmetics?.({
      profileId: cosmeticProfileId,
      selection: { [slot]: next }
    });
    if (!result?.success) {
      showToast('Could not save the cosmetic pick.', 'error');
      return;
    }
    cosmeticSelection = result.selection;
    renderCosmeticsGrid();
    syncCosmeticPreview();
    showToast(next ? `${item?.name || 'Cosmetic'} will be worn in-game.` : 'That slot will be empty.', 'success');
  } catch (err) {
    showToast('Could not save the cosmetic pick.', 'error');
  }
}

function cosmeticName(type, id) {
  if (!id) return '';
  const item = cosmeticItems.find((entry) => entry.id === id);
  return item?.name || id;
}

function cosmeticChip(label, name) {
  const worn = !!name;
  return `<span class="max-w-[130px] truncate text-[10px] px-1.5 py-0.5 rounded ${worn ? 'text-white bg-white/10' : 'text-white/30 bg-white/[0.04]'}"
                title="${cosmeticEsc(name || 'Nothing worn')}">${label} · ${cosmeticEsc(name || 'None')}</span>`;
}

function syncCosmeticPreview() {
  const worn = document.getElementById('cosmetic-worn');
  if (worn) {
    worn.innerHTML = cosmeticChip('Hat', cosmeticName('hat', cosmeticSelection.hat))
      + cosmeticChip('Cape', cosmeticName('cape', cosmeticSelection.cape));
  }

  window.CosmeticPreview?.setLook({ hat: cosmeticSelection.hat, cape: cosmeticSelection.cape });

  const flat = document.getElementById('cosmetic-stage-flat');
  if (flat) {
    const shown = cosmeticItems.find((entry) => entry.id === (cosmeticSelection.hat || cosmeticSelection.cape));
    if (shown?.preview) flat.src = shown.preview;
  }
}

async function resolvePreviewSkin() {
  const skin = typeof selectedSkin !== 'undefined' ? selectedSkin : null;
  try {
    if (skin && !skin.skinUrl && typeof ensureSkinArt === 'function') await ensureSkinArt(skin);
  } catch (err) {
    /* the mirror can be down; the viewer falls back to a plain body */
  }
  if (skin?.skinUrl) {
    window.CosmeticPreview?.setPlayer({ url: skin.skinUrl, type: skin.type });
    return;
  }
  const name = skin?.username || document.getElementById('nav-username')?.textContent?.trim();
  if (!name) return;
  try {
    const texture = await window.electronAPI?.getSkinTexture?.(name);
    if (texture) window.CosmeticPreview?.setPlayer({ url: texture, type: skin?.type });
  } catch (err) {
    /* keep the plain body */
  }
}
