/* A Minecraft skin is an atlas of the player's faces, not a picture of a
   player. Everything below cuts the real faces out of the texture — uploaded
   by the user or downloaded for a username — so every head in the UI is that
   skin's own pixels. */

const SKIN_FALLBACK = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'><rect width='8' height='8' fill='#22242b'/><rect x='2' y='1' width='4' height='3' fill='#3d414c'/><rect x='1' y='4' width='6' height='3' fill='#343843'/></svg>"
);

function skinFallback(img) {
  img.onerror = null;
  img.src = SKIN_FALLBACK;
}

/* Resolves to the decoded texture, rejecting anything that is not a skin so a
   wrong file cannot be drawn as a face. */
function loadSkinTexture(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const ok = img.naturalWidth >= 64 && img.naturalWidth % 64 === 0 && img.naturalHeight >= 32;
      if (ok) resolve(img); else reject(new Error('not a skin texture'));
    };
    img.onerror = () => reject(new Error('unreadable texture'));
    img.src = src;
  });
}

// 1.8 layout. Front faces of each body part, and the atlas origin of the one
// we can stack on top of it (hat, jacket, right sleeve).
const FRONT_LAYERS = [
  { sx: 8, sy: 8, w: 8, h: 8, dx: 4, dy: 0, overlay: { x: 40, y: 8 } },
  { sx: 20, sy: 20, w: 8, h: 12, dx: 4, dy: 8, overlay: { x: 20, y: 36 } },
  { sx: 44, sy: 20, w: 4, h: 12, dx: 0, dy: 8, overlay: { x: 44, y: 36 } },
  { sx: 36, sy: 52, w: 4, h: 12, dx: 12, dy: 8, overlay: { x: 52, y: 52 } },
  { sx: 4, sy: 20, w: 4, h: 12, dx: 4, dy: 20 },
  { sx: 20, sy: 52, w: 4, h: 12, dx: 8, dy: 20 }
];

// Slim arms are three pixels wide, so the body sits one pixel narrower and
// the sleeves come from their own atlas strips.
const SLIM_LAYERS = [
  FRONT_LAYERS[0],
  FRONT_LAYERS[1],
  { sx: 44, sy: 20, w: 3, h: 12, dx: 1, dy: 8, overlay: { x: 44, y: 36 } },
  { sx: 36, sy: 52, w: 3, h: 12, dx: 12, dy: 8, overlay: { x: 52, y: 52 } },
  FRONT_LAYERS[4],
  FRONT_LAYERS[5]
];

// 64x32 skins mirror the right limbs onto the left and have no overlays.
const LEGACY_LAYERS = [
  FRONT_LAYERS[0],
  FRONT_LAYERS[1],
  { sx: 44, sy: 20, w: 4, h: 12, dx: 0, dy: 8 },
  { sx: 44, sy: 20, w: 4, h: 12, dx: 12, dy: 8 },
  { sx: 4, sy: 20, w: 4, h: 12, dx: 4, dy: 20 },
  { sx: 4, sy: 20, w: 4, h: 12, dx: 8, dy: 20 }
];

const LEGACY_SLIM_LAYERS = [
  LEGACY_LAYERS[0],
  LEGACY_LAYERS[1],
  { sx: 44, sy: 20, w: 3, h: 12, dx: 1, dy: 8 },
  { sx: 44, sy: 20, w: 3, h: 12, dx: 12, dy: 8 },
  LEGACY_LAYERS[4],
  LEGACY_LAYERS[5]
];

function newSkinCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  return { canvas, ctx };
}

/* The head alone: the face plus the hat layer worn over it. */
async function headFromSkinTexture(src, size = 64) {
  const img = await loadSkinTexture(src);
  const u = img.naturalWidth / 64;
  const { canvas, ctx } = newSkinCanvas(size, size);

  ctx.drawImage(img, 8 * u, 8 * u, 8 * u, 8 * u, 0, 0, size, size);
  if (img.naturalHeight >= 64) {
    ctx.drawImage(img, 40 * u, 8 * u, 8 * u, 8 * u, 0, 0, size, size);
  }
  return canvas.toDataURL('image/png');
}

/* The whole player as seen from the front, assembled from the texture.
   `model` picks the arm width: slim skins have 3px arms at their own atlas
   offsets, classic skins have 4px arms. */
async function frontFromSkinTexture(src, scale = 8, model = 'classic') {
  const img = await loadSkinTexture(src);
  const u = img.naturalWidth / 64;
  const slim = model === 'slim';
  const legacy = img.naturalHeight < 64;
  const layers = legacy
    ? (slim ? LEGACY_SLIM_LAYERS : LEGACY_LAYERS)
    : (slim ? SLIM_LAYERS : FRONT_LAYERS);
  const { canvas, ctx } = newSkinCanvas(16 * scale, 32 * scale);

  const paint = (layer) => {
    ctx.drawImage(
      img,
      layer.sx * u, layer.sy * u, layer.w * u, layer.h * u,
      layer.dx * scale, layer.dy * scale, layer.w * scale, layer.h * scale
    );
  };

  layers.forEach(paint);
  if (!legacy) {
    layers.forEach((layer) => {
      if (!layer.overlay) return;
      paint({ sx: layer.overlay.x, sy: layer.overlay.y, w: layer.w, h: layer.h, dx: layer.dx, dy: layer.dy });
    });
  }
  return canvas.toDataURL('image/png');
}

/* ---------- username lookup ---------- */

const skinTextureCache = new Map();
const headCache = new Map();

async function skinTextureForUsername(username) {
  const name = (username || '').trim();
  if (name.length < 3 || !window.electronAPI?.getSkinTexture) return null;
  if (skinTextureCache.has(name)) return skinTextureCache.get(name);

  const texture = await window.electronAPI.getSkinTexture(name);
  if (texture) skinTextureCache.set(name, texture);
  return texture;
}

async function headForUsername(username, size = 64) {
  const name = (username || '').trim();
  if (name.length < 3) return null;

  const key = `${name.toLowerCase()}:${size}`;
  if (headCache.has(key)) return headCache.get(key);

  const texture = await skinTextureForUsername(name);
  if (!texture) return null;

  try {
    const head = await headFromSkinTexture(texture, size);
    headCache.set(key, head);
    return head;
  } catch (err) {
    return null;
  }
}
