let skinsLibrary = [
  { id: '1', name: 'Notch', username: 'Notch', type: 'classic', bodyUrl: null, headUrl: null, skinUrl: null },
  { id: '2', name: 'Steve', username: 'Steve', type: 'classic', bodyUrl: null, headUrl: null, skinUrl: null },
  { id: '3', name: 'jeb_', username: 'jeb_', type: 'classic', bodyUrl: null, headUrl: null, skinUrl: null }
];

let selectedSkin = skinsLibrary[0];
let skinsReady = false;

function skinBody(skin) {
  if (!skin) return SKIN_FALLBACK;
  return skin.bodyUrl || skin.bodyUrls?.[skin.type] || skin.bodyUrls?.classic || SKIN_FALLBACK;
}

function skinEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

/* ---------- persistence ---------- */

function skinsSnapshot() {
  return {
    selectedId: selectedSkin?.id || null,
    skins: skinsLibrary.map((skin) => ({
      id: skin.id,
      name: skin.name,
      username: skin.username,
      type: skin.type,
      custom: skin.custom === true,
      skinUrl: skin.skinUrl || null,
      headUrl: skin.headUrl || null,
      bodyUrl: skin.bodyUrl || null,
      bodyUrls: skin.bodyUrls || null
    }))
  };
}

let saveTimer = null;
function persistSkins() {
  if (!skinsReady || !window.electronAPI?.saveSkins) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => window.electronAPI.saveSkins(skinsSnapshot()), 250);
}

async function loadSkins() {
  if (!window.electronAPI?.getSkins) { skinsReady = true; return; }
  try {
    const saved = await window.electronAPI.getSkins();
    const restored = Array.isArray(saved?.skins)
      ? saved.skins.filter((skin) => skin?.id && (skin.skinUrl || skin.username))
      : [];
    if (restored.length) {
      skinsLibrary = restored;
      selectedSkin = skinsLibrary.find((skin) => skin.id === saved.selectedId) || skinsLibrary[0];
    }
  } catch (err) {
    // keep the built-in library
  }
  skinsReady = true;

  // The launcher needs the texture itself, not just the name, so fetch it
  // once for whichever skin is selected.
  if (selectedSkin && !selectedSkin.skinUrl) {
    ensureSkinArt(selectedSkin).then((skin) => {
      if (skin?.skinUrl) persistSkins();
    });
  }

  const view = document.getElementById('skins-view');
  if (view && !view.classList.contains('hidden')) renderSkinsGrid();
  if (selectedSkin?.headUrl) {
    const avatar = document.getElementById('nav-user-avatar');
    if (avatar) avatar.src = selectedSkin.headUrl;
  }
}

document.addEventListener('DOMContentLoaded', loadSkins);

/* Every skin's picture is built from its own texture: the head for the chip
   and the card, and both arm widths for the stage so switching models
   actually changes the body instead of only the button. */
async function ensureSkinArt(skin) {
  if (skin.bodyUrls || skin.building) return skin;
  skin.building = true;

  try {
    const texture = skin.skinUrl || await skinTextureForUsername(skin.username);
    if (!texture) return skin;

    skin.skinUrl = texture;
    skin.headUrl = await headFromSkinTexture(texture, 64);
    skin.bodyUrls = {
      classic: await frontFromSkinTexture(texture, 8, 'classic'),
      slim: await frontFromSkinTexture(texture, 8, 'slim')
    };
    skin.bodyUrl = skin.bodyUrls[skin.type] || skin.bodyUrls.classic;
  } catch (err) {
    return skin;
  } finally {
    skin.building = false;
  }

  const view = document.getElementById('skins-view');
  const visible = view && !view.classList.contains('hidden');
  if (visible) {
    renderSkinsGrid();
    if (selectedSkin?.id === skin.id) {
      document.getElementById('preview-full-body').src = skinBody(skin);
    }
  }
  return skin;
}

function renderSkinsGrid() {
  const grid = document.getElementById('skins-grid');
  if (!grid) return;

  grid.innerHTML = skinsLibrary.map(skin => `
    <div onclick="selectSkin('${skin.id}')" class="group relative bg-white/[0.03] hover:bg-white/[0.06] border ${selectedSkin?.id === skin.id ? 'border-white/30' : 'border-white/[0.07]'} rounded-lg p-2.5 flex flex-col items-center cursor-pointer transition-colors">
      
      <button onclick="event.stopPropagation(); deleteSkin('${skin.id}')" title="Delete skin" aria-label="Delete skin" class="absolute top-1.5 right-1.5 text-white/30 hover:text-[#e0685d] p-1 transition-colors cursor-pointer opacity-0 group-hover:opacity-100">
        <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path></svg>
      </button>

      <div class="h-24 flex items-center justify-center my-1">
        <img src="${skinBody(skin)}" alt="${skinEscape(skin.name)}" onerror="skinFallback(this)" class="h-full object-contain pixelated drop-shadow-md" />
      </div>

      <div class="w-full pt-2 border-t border-white/[0.06] text-left">
        <h4 class="text-[11px] font-medium text-white/85 truncate">${skinEscape(skin.name)}</h4>
        <span class="text-[10px] text-white/30">${skin.type === 'slim' ? 'Slim' : 'Classic'} model</span>
      </div>
    </div>
  `).join('');

  // Coming back to this tab should show the skin that is actually selected,
  // not whatever the preview happened to hold last time.
  const nameEl = document.getElementById('preview-skin-name');
  const bodyEl = document.getElementById('preview-full-body');
  if (selectedSkin) {
    if (nameEl) nameEl.textContent = selectedSkin.name;
    if (bodyEl && bodyEl.getAttribute('src') !== skinBody(selectedSkin)) {
      bodyEl.src = skinBody(selectedSkin);
    }
  }

  skinsLibrary.forEach((skin) => { if (!skin.bodyUrls) ensureSkinArt(skin); });
}

function selectSkin(id) {
  const found = skinsLibrary.find(s => s.id === id);
  if (!found) return;

  selectedSkin = found;
  document.getElementById('preview-skin-name').textContent = found.name;
  document.getElementById('preview-full-body').src = skinBody(found);
  setSkinModel(found.type, false);
  renderSkinsGrid();
  persistSkins();
}

function setSkinModel(model, updateSkin = true) {
  const classicBtn = document.getElementById('model-classic-btn');
  const slimBtn = document.getElementById('model-slim-btn');

  if (model === 'classic') {
    classicBtn.className = 'px-2 py-0.5 text-[11px] font-medium rounded text-white bg-white/10 cursor-pointer';
    slimBtn.className = 'px-2 py-0.5 text-[11px] font-medium rounded text-white/40 hover:text-white cursor-pointer';
  } else {
    slimBtn.className = 'px-2 py-0.5 text-[11px] font-medium rounded text-white bg-white/10 cursor-pointer';
    classicBtn.className = 'px-2 py-0.5 text-[11px] font-medium rounded text-white/40 hover:text-white cursor-pointer';
  }

  if (updateSkin && selectedSkin) {
    selectedSkin.type = model;
    selectedSkin.bodyUrl = selectedSkin.bodyUrls?.[model] || selectedSkin.bodyUrl;
    document.getElementById('preview-full-body').src = skinBody(selectedSkin);
    renderSkinsGrid();
    persistSkins();
  }
}

document.getElementById('skin-search-input')?.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const val = e.target.value.trim();
  if (!val) return;
  e.target.value = '';

  const texture = await skinTextureForUsername(val);
  if (!texture) {
    showToast(`No skin found for ${val}.`, 'error');
    return;
  }

  const newSkin = {
    id: Date.now().toString(),
    name: val,
    username: val,
    type: 'classic',
    skinUrl: texture,
    headUrl: null,
    bodyUrl: null
  };

  skinsLibrary.unshift(newSkin);
  await ensureSkinArt(newSkin);
  renderSkinsGrid();
  selectSkin(newSkin.id);
  persistSkins();
  showToast(`Added a skin for ${val}.`, 'success');
});

function handleSkinFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = '';

  const reader = new FileReader();
  reader.onload = async (e) => {
    const customSkin = {
      id: Date.now().toString(),
      name: file.name.replace(/\.png$/i, ''),
      username: 'Custom',
      type: 'classic',
      custom: true,
      skinUrl: e.target.result,
      headUrl: null,
      bodyUrl: null
    };

    // Reading the faces out of the file doubles as validation: anything that
    // is not a skin texture fails here instead of rendering as a face.
    await ensureSkinArt(customSkin);
    if (!customSkin.bodyUrl) {
      showToast('That file is not a Minecraft skin.', 'error');
      return;
    }

    skinsLibrary.unshift(customSkin);
    renderSkinsGrid();
    selectSkin(customSkin.id);
    persistSkins();
    showToast('Skin uploaded.', 'success');
  };
  reader.readAsDataURL(file);
}

function deleteSkin(id) {
  if (skinsLibrary.length <= 1) {
    showToast('Keep at least one skin in your library.', 'error');
    return;
  }
  skinsLibrary = skinsLibrary.filter(s => s.id !== id);
  if (selectedSkin?.id === id) selectedSkin = skinsLibrary[0];
  renderSkinsGrid();
  selectSkin(selectedSkin.id);
  persistSkins();
  showToast('Skin deleted.', 'info');
}

async function applyCurrentSkin() {
  if (!selectedSkin) return;

  await ensureSkinArt(selectedSkin);
  const head = selectedSkin.headUrl;
  if (!head) {
    showToast(`No skin texture found for ${selectedSkin.name}.`, 'error');
    return;
  }

  document.getElementById('nav-user-avatar').src = head;
  persistSkins();

  const saved = JSON.parse(localStorage.getItem('flash_session') || 'null');
  if (saved) localStorage.setItem('flash_session', JSON.stringify({ ...saved, avatar: head }));

  showToast(`${selectedSkin.name} is now your skin.`, 'success');
}

function changePanorama(val) {
  const stage = document.getElementById('skin-stage-bg');
  const art = {
    meadow: 'images/stage-meadow-2048x2048.png',
    sunset: 'images/stage-sunset-2048x2048.png'
  }[val];
  if (stage && art) stage.style.backgroundImage = `url('${art}')`;
}
