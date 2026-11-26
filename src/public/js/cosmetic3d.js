/* Live in-game look for the Cosmetics tab: the account's own skin wearing the
   saved hat and cape. Everything is drawn in the same pixel space the client
   uses — 1 unit = 1 skin pixel, y up, neck at 24, head top at 32 — and the hat
   models are the shipped .bbmodel files, parsed the way the client parses them.
   Needs the global THREE from js/vendor/three.min.js. */

window.CosmeticPreview = (function () {
  const DEG = Math.PI / 180;
  const SLOT = { px: 0, nx: 1, py: 2, ny: 3, pz: 4, nz: 5 };

  const FACE_HEAD = {
    px: [16, 8, 24, 16], nx: [0, 8, 8, 16],
    py: [8, 0, 16, 8], ny: [16, 0, 24, 8],
    pz: [24, 8, 32, 16], nz: [8, 8, 16, 16]
  };
  const FACE_BODY = {
    px: [28, 20, 32, 32], nx: [16, 20, 20, 32],
    py: [20, 16, 28, 20], ny: [28, 16, 36, 20],
    pz: [32, 20, 40, 32], nz: [20, 20, 28, 32]
  };
  const FACE_ARM_R = {
    px: [48, 20, 52, 32], nx: [40, 20, 44, 32],
    py: [44, 16, 48, 20], ny: [48, 16, 52, 20],
    pz: [52, 20, 56, 32], nz: [44, 20, 48, 32]
  };
  const FACE_ARM_L = {
    px: [40, 52, 44, 64], nx: [32, 52, 36, 64],
    py: [36, 48, 40, 52], ny: [40, 48, 44, 52],
    pz: [44, 52, 48, 64], nz: [36, 52, 40, 64]
  };
  const FACE_LEG_R = {
    px: [8, 20, 12, 32], nx: [0, 20, 4, 32],
    py: [4, 16, 8, 20], ny: [8, 16, 12, 20],
    pz: [12, 20, 16, 32], nz: [4, 20, 8, 32]
  };
  const FACE_LEG_L = {
    px: [24, 52, 28, 64], nx: [16, 52, 20, 64],
    py: [20, 48, 24, 52], ny: [24, 48, 28, 52],
    pz: [28, 52, 32, 64], nz: [20, 52, 24, 64]
  };

  const BB_FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
  // Same order as a BoxGeometry's material slots.
  const BB_ORDER = ['east', 'west', 'up', 'down', 'south', 'north'];

  let renderer = null, scene = null, camera = null, rig = null;
  let stage = null, canvas = null, flat = null;
  let playerGroup = null, hatHolder = null, capeHolder = null;
  let booted = false, broken = false;

  let look = { hat: '', cape: '' };
  let hatToken = 0, capeToken = 0, skinToken = 0;
  let skinState = { url: '', slim: false, texture: null };

  let yaw = 0.7, pitch = 0.06;
  let dragging = false, dragX = 0, dragY = 0, lastDragEnd = 0;

  function init() {
    if (booted || broken) return;
    canvas = document.getElementById('cosmetic-stage-canvas');
    stage = document.getElementById('cosmetic-stage');
    flat = document.getElementById('cosmetic-stage-flat');
    if (!canvas || !stage) return;
    if (typeof THREE === 'undefined') { fallback(); return; }

    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch (err) {
      fallback();
      return;
    }
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearAlpha(0);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(30, 1, 1, 500);
    camera.position.set(0, 27, 63);
    camera.lookAt(0, 26.5, 0);

    rig = new THREE.Group();
    scene.add(rig);

    playerGroup = new THREE.Group();
    hatHolder = new THREE.Group();
    capeHolder = new THREE.Group();
    rig.add(playerGroup, hatHolder, capeHolder);

    buildPlayer(null, false);

    canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      dragX = e.clientX;
      dragY = e.clientY;
      canvas.setPointerCapture?.(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      yaw += (e.clientX - dragX) * 0.011;
      pitch = Math.max(-0.2, Math.min(0.2, pitch + (e.clientY - dragY) * 0.005));
      dragX = e.clientX;
      dragY = e.clientY;
    });
    const release = () => {
      if (!dragging) return;
      dragging = false;
      lastDragEnd = performance.now();
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);

    new ResizeObserver(resize).observe(stage);
    window.addEventListener('resize', resize);
    resize();
    booted = true;
    requestAnimationFrame(frame);
  }

  function fallback() {
    broken = true;
    if (canvas) canvas.classList.add('hidden');
    if (flat) flat.classList.remove('hidden');
  }

  function resize() {
    if (!renderer || !stage) return;
    const w = Math.max(1, stage.clientWidth);
    const h = Math.max(1, stage.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (!renderer || !stage) return;
    if (document.hidden || stage.offsetParent === null) return;
    if (!dragging && now - lastDragEnd > 2200) yaw += 0.0038;
    rig.rotation.y = yaw;
    camera.position.set(0, 27 + pitch * 60, 63);
    camera.lookAt(0, 26.5 + pitch * 18, 0);
    renderer.render(scene, camera);
  }

  /* ---------- skin ---------- */

  function buildPlayer(texture, slim) {
    const keepTexture = texture;
    while (playerGroup.children.length) {
      const child = playerGroup.children.pop();
      child.geometry?.dispose?.();
      (Array.isArray(child.material) ? child.material : [child.material]).forEach((m) => m?.map?.dispose?.());
    }
    const layout = { w: 64, h: texture && texture.image ? layoutHeight(texture.image) : 64 };
    const legacy = layout.h === 32;
    const armFacesL = legacy ? FACE_ARM_R : FACE_ARM_L;
    const legFacesL = legacy ? FACE_LEG_R : FACE_LEG_L;
    const armX = slim ? 5.5 : 6;
    const armW = slim ? 3 : 4;

    box(playerGroup, keepTexture, [armW, 12, 4], [-armX, 18, 0], FACE_ARM_R, layout.h);
    box(playerGroup, keepTexture, [armW, 12, 4], [armX, 18, 0], armFacesL, layout.h);
    box(playerGroup, keepTexture, [4, 12, 4], [-2, 6, 0], FACE_LEG_R, layout.h);
    box(playerGroup, keepTexture, [4, 12, 4], [2, 6, 0], legFacesL, layout.h);
    box(playerGroup, keepTexture, [8, 12, 4], [0, 18, 0], FACE_BODY, layout.h);
    box(playerGroup, keepTexture, [8, 8, 8], [0, 28, 0], FACE_HEAD, layout.h);
  }

  function layoutHeight(image) {
    return image.width === image.height ? 64 : 32;
  }

  function box(parent, texture, size, center, faces, layoutH) {
    const geo = new THREE.BoxGeometry(size[0], size[1], size[2]);
    const mats = [];
    for (let i = 0; i < 6; i++) {
      const key = BB_FACES[i];
      const rect = faces[key];
      mats.push(rect ? faceMaterial(texture, rect, 64, layoutH) : hiddenMaterial());
    }
    const mesh = new THREE.Mesh(geo, mats);
    mesh.position.set(center[0], center[1], center[2]);
    parent.add(mesh);
  }

  function hiddenMaterial() {
    return new THREE.MeshBasicMaterial({ visible: false });
  }

  function faceMaterial(texture, rect, sheetW, sheetH) {
    if (!texture) return new THREE.MeshBasicMaterial({ color: 0x6f7f95 });
    const tex = texture.clone();
    tex.needsUpdate = true;
    tex.encoding = THREE.sRGBEncoding;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.repeat.set((rect[2] - rect[0]) / sheetW, (rect[3] - rect[1]) / sheetH);
    tex.offset.set(rect[0] / sheetW, 1 - rect[3] / sheetH);
    return new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.04 });
  }

  function fallbackSkinTexture() {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#8a9bb3';
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#4f5f78';
    g.fillRect(0, 16, 64, 16);
    g.fillStyle = '#c99a75';
    g.fillRect(8, 8, 8, 8);
    g.fillRect(0, 8, 8, 8);
    g.fillRect(16, 8, 8, 8);
    g.fillRect(24, 8, 8, 8);
    const tex = new THREE.Texture(c);
    tex.needsUpdate = true;
    return tex;
  }

  function setPlayer(info) {
    if (broken) return;
    init();
    if (!booted || !info) {
      if (booted && !playerGroup.children.length) buildPlayer(null, false);
      return;
    }
    const url = info.url || '';
    const slim = String(info.type || '').toLowerCase() === 'slim';
    if (url === skinState.url && slim === skinState.slim && skinState.texture) return;
    const token = ++skinToken;
    skinState = { url, slim, texture: null };

    if (!url) {
      buildPlayer(fallbackSkinTexture(), slim);
      return;
    }
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    loader.load(url, (tex) => {
      if (token !== skinToken) return;
      tex.encoding = THREE.sRGBEncoding;
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      skinState.texture = tex;
      buildPlayer(tex, slim);
      applyHat(look.hat);
      applyCape(look.cape);
    }, undefined, () => {
      if (token !== skinToken) return;
      buildPlayer(fallbackSkinTexture(), slim);
    });
  }

  /* ---------- hat ---------- */

  function setLook(next) {
    look = { hat: next?.hat || '', cape: next?.cape || '' };
    if (!booted) { init(); }
    if (!booted) {
      if (flat) {
        const el = document.getElementById('cosmetic-stage-note');
        if (el && !el.textContent) el.textContent = '3D preview needs the desktop app.';
      }
      return;
    }
    applyHat(look.hat);
    applyCape(look.cape);
  }

  function clearGroup(group) {
    while (group.children.length) {
      const child = group.children.pop();
      child.traverse?.((n) => {
        n.geometry?.dispose?.();
        (Array.isArray(n.material) ? n.material : [n.material]).forEach((m) => m?.map?.dispose?.());
      });
    }
  }

  async function applyHat(id) {
    const token = ++hatToken;
    clearGroup(hatHolder);
    if (!id) return;
    try {
      const model = await fetch(`cosmetic/models/${id}.bbmodel`).then((r) => {
        if (!r.ok) throw new Error('model');
        return r.json();
      });
      if (token !== hatToken) return;
      const tex = await loadTexture(`cosmetic/textures/hats/${id}.png`);
      if (token !== hatToken) return;
      const group = buildHat(model, tex);
      hatHolder.add(group);
    } catch (err) {
      /* Not every catalogue item ships a local model; the stage just stays bare. */
    }
  }

  function loadTexture(url) {
    return new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(url, (tex) => {
        tex.encoding = THREE.sRGBEncoding;
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        resolve(tex);
      }, undefined, reject);
    });
  }

  function buildHat(model, texture) {
    const group = new THREE.Group();
    const w = model.resolution?.width || model.meta?.resolution?.width || 512;
    const h = model.resolution?.height || model.meta?.resolution?.height || 512;
    (model.elements || []).forEach((el) => {
      if (!el.from || !el.to) return;
      const inflate = Number(el.inflate) || 0;
      const sx = el.to[0] - el.from[0] + inflate * 2;
      const sy = el.to[1] - el.from[1] + inflate * 2;
      const sz = el.to[2] - el.from[2] + inflate * 2;
      if (sx <= 0 || sy <= 0 || sz <= 0) return;

      const geo = new THREE.BoxGeometry(sx, sy, sz);
      const mats = [];
      for (let i = 0; i < 6; i++) {
        const face = el.faces?.[BB_ORDER[i]];
        if (!face || !face.uv) { mats.push(hiddenMaterial()); continue; }
        mats.push(faceMaterial(texture, face.uv, w, h));
      }
      const mesh = new THREE.Mesh(geo, mats);

      const cx = (el.from[0] + el.to[0]) / 2;
      const cy = (el.from[1] + el.to[1]) / 2;
      const cz = (el.from[2] + el.to[2]) / 2;
      const rot = el.rotation || [0, 0, 0];
      const origin = el.origin || [0, 0, 0];
      if (rot[0] || rot[1] || rot[2]) {
        const pivot = new THREE.Group();
        pivot.position.set(origin[0], origin[1], origin[2]);
        pivot.rotation.set(rot[0] * DEG, rot[1] * DEG, rot[2] * DEG);
        mesh.position.set(cx - origin[0], cy - origin[1], cz - origin[2]);
        pivot.add(mesh);
        group.add(pivot);
      } else {
        mesh.position.set(cx, cy, cz);
        group.add(mesh);
      }
    });
    return group;
  }

  /* ---------- cape ---------- */

  async function applyCape(id) {
    const token = ++capeToken;
    clearGroup(capeHolder);
    if (!id) return;
    try {
      const tex = await loadTexture(`cosmetic/textures/capes/${id}.png`);
      if (token !== capeToken) return;
      // The vanilla cloak unwrap: 10x16 face at (1,1) of a 64x32 sheet.
      tex.repeat.set(10 / 64, 16 / 32);
      tex.offset.set(1 / 64, 1 - 17 / 32);
      const geo = new THREE.PlaneGeometry(10, 16);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        map: tex, alphaTest: 0.04, side: THREE.DoubleSide
      }));
      const holder = new THREE.Group();
      holder.position.set(0, 16, 2.55);
      holder.rotation.x = -0.1;
      mesh.position.set(0, 0, 0);
      holder.add(mesh);
      capeHolder.add(holder);
    } catch (err) {
      /* A cape without a local sheet simply stays off the preview. */
    }
  }

  function setRotation(rad) {
    if (typeof rad === 'number' && isFinite(rad)) {
      yaw = rad;
      lastDragEnd = performance.now();
    }
  }

  return { init, setLook, setPlayer, resize, setRotation };
})();
