/* A tiny canvas game for the download screen: move the player along the
   ground, collect diamonds, dodge creepers. No engine, no assets — just the
   same pixel sizes Minecraft uses so it reads as part of the launcher. */

const MiniGame = (() => {
  const W = 240;
  const H = 150;
  const GROUND = 128;

  let canvas = null;
  let ctx = null;
  let frame = 0;
  let running = false;
  let last = 0;
  let spawnIn = 0.8;
  let flash = 0;

  const player = { x: W / 2 - 7, y: GROUND - 20, w: 14, h: 20, speed: 138 };
  const keys = new Set();
  const items = [];
  let score = 0;

  function bindKeys(on) {
    if (on) {
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
    } else {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      keys.clear();
    }
  }

  function onKeyDown(e) {
    const key = e.key.toLowerCase();
    if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'a', 'd', 'w', 's'].includes(key)) {
      keys.add(key);
      if (running) e.preventDefault();
    }
  }

  function onKeyUp(e) {
    keys.delete(e.key.toLowerCase());
  }

  function setScore(value) {
    score = value;
    const el = document.getElementById('minigame-score');
    if (el) el.textContent = String(score);
  }

  function spawn() {
    const creeper = Math.random() < 0.55;
    items.push({
      type: creeper ? 'creeper' : 'diamond',
      x: 8 + Math.random() * (W - 24),
      y: -16,
      w: creeper ? 12 : 8,
      h: creeper ? 14 : 8,
      vy: creeper ? 46 + Math.random() * 30 : 60 + Math.random() * 40
    });
  }

  function intersects(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function drawBackground() {
    ctx.fillStyle = '#12141a';
    ctx.fillRect(0, 0, W, H);

    // A few static stars so the field does not feel empty.
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    for (let i = 0; i < 18; i += 1) {
      const x = (i * 53 + 11) % W;
      const y = (i * 37 + 17) % 100;
      ctx.fillRect(x, y, 1, 1);
    }

    ctx.fillStyle = '#1a1d24';
    ctx.fillRect(0, GROUND, W, H - GROUND);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(0, GROUND, W, 1);
  }

  function drawPlayer() {
    const { x, y } = player;
    ctx.fillStyle = '#b3805a';
    ctx.fillRect(x + 2, y, 10, 8);          // head
    ctx.fillStyle = '#2f6f7e';
    ctx.fillRect(x + 2, y + 8, 10, 8);      // shirt
    ctx.fillStyle = '#3a3a6e';
    ctx.fillRect(x + 2, y + 16, 4, 4);      // legs
    ctx.fillRect(x + 8, y + 16, 4, 4);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(x + 4, y + 3, 2, 2);       // eyes
    ctx.fillRect(x + 8, y + 3, 2, 2);
  }

  function drawCreeper(item) {
    ctx.fillStyle = '#4f9e57';
    ctx.fillRect(item.x, item.y, item.w, item.h);
    ctx.fillStyle = '#2f6b36';
    ctx.fillRect(item.x + 2, item.y + 3, item.w - 4, 4);
    ctx.fillStyle = '#0f2413';
    ctx.fillRect(item.x + 3, item.y + 4, 2, 2);
    ctx.fillRect(item.x + item.w - 5, item.y + 4, 2, 2);
    ctx.fillRect(item.x + 5, item.y + 8, 2, 3);
  }

  function drawDiamond(item) {
    ctx.fillStyle = '#4fd1d9';
    ctx.beginPath();
    ctx.moveTo(item.x + item.w / 2, item.y);
    ctx.lineTo(item.x + item.w, item.y + item.h / 2);
    ctx.lineTo(item.x + item.w / 2, item.y + item.h);
    ctx.lineTo(item.x, item.y + item.h / 2);
    ctx.closePath();
    ctx.fill();
  }

  function step(dt) {
    let dx = 0;
    if (keys.has('arrowleft') || keys.has('a')) dx -= 1;
    if (keys.has('arrowright') || keys.has('d')) dx += 1;
    player.x = Math.max(2, Math.min(W - player.w - 2, player.x + dx * player.speed * dt));

    spawnIn -= dt;
    if (spawnIn <= 0) {
      spawn();
      spawnIn = Math.max(0.32, 0.9 - score * 0.012);
    }

    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      item.y += item.vy * dt;

      if (item.y > GROUND - item.h + 6) {
        items.splice(i, 1);
        continue;
      }

      if (intersects(player, item)) {
        items.splice(i, 1);
        if (item.type === 'diamond') {
          setScore(score + 1);
        } else {
          setScore(Math.max(0, score - 3));
          flash = 0.3;
        }
      }
    }

    flash = Math.max(0, flash - dt);
  }

  function draw() {
    drawBackground();
    for (const item of items) {
      if (item.type === 'creeper') drawCreeper(item);
      else drawDiamond(item);
    }
    drawPlayer();

    if (flash > 0) {
      ctx.fillStyle = `rgba(224,79,79,${0.18 + flash * 0.5})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  function frameLoop(now) {
    if (!running) return;
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    step(dt);
    draw();
    frame = window.requestAnimationFrame(frameLoop);
  }

  function start(enabled) {
    canvas = document.getElementById('minigame-canvas');
    if (!canvas) return;

    ctx = canvas.getContext('2d');
    running = true;
    bindKeys(true);

    if (enabled === false) {
      running = false;
      bindKeys(false);
      drawBackground();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Minigame is off in Settings', W / 2, H / 2);
      ctx.textAlign = 'left';
      return;
    }

    items.length = 0;
    setScore(0);
    player.x = W / 2 - player.w / 2;
    spawnIn = 0.7;
    flash = 0;
    last = performance.now();
    cancelAnimationFrame(frame);
    frame = window.requestAnimationFrame(frameLoop);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(frame);
    bindKeys(false);
    items.length = 0;
  }

  return { start, stop };
})();
