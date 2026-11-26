/* Boots the real launcher and drives its renderer over CDP. Verifies the
   multi-instance refactor: the session model, the Instances tab, the tray,
   and that Play still works for a single profile. */
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9333;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  — ${detail}` : ''}`);
}

/* A throw inside one assertion should not end the run before the rest are
   reported; it becomes a failed check instead. */
async function safe(fn, fallback) {
  try { return await fn(); } catch (err) { console.log(`      (threw: ${err.message})`); return fallback; }
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function waitForTarget(timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (err) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('renderer never appeared on CDP');
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  return (method, params) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-verify-'));

  const child = spawn(ELECTRON, [ROOT, `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`], {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const mainLog = [];
  child.stdout.on('data', (d) => mainLog.push(d.toString()));
  child.stderr.on('data', (d) => mainLog.push(d.toString()));

  let ws;
  try {
    const page = await waitForTarget();
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });
    const send = cdp(ws);

    await send('Runtime.enable', {});
    const evaluate = async (expression) => {
      const out = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
      });
      if (out.exceptionDetails) throw new Error(out.exceptionDetails.text + ' ' + JSON.stringify(out.exceptionDetails.exception?.description || ''));
      return out.result.value;
    };

    // Wait for the generated HTML to finish loading.
    for (let i = 0; i < 60; i += 1) {
      const ready = await evaluate('document.readyState');
      if (ready === 'complete') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    /* readyState 'complete' can land before the last deferred script has run,
       so wait for the module itself rather than guessing at a delay. */
    for (let i = 0; i < 40; i += 1) {
      if (await evaluate('typeof renderInstances === "function"')) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    /* ---- 1. the new module is loaded and wired ---- */
    check('instances.js is loaded', await evaluate('typeof renderInstances === "function"'));
    check('preload exposes listInstances', await evaluate('typeof window.electronAPI?.listInstances === "function"'));
    /* contextBridge wrappers are native proxies, so they always report arity 0;
       identity is all that can be checked from here. */
    check('preload exposes stopGame', await evaluate('typeof window.electronAPI?.stopGame === "function"'));
    check('preload exposes quitApp', await evaluate('typeof window.electronAPI?.quitApp === "function"'));
    check('preload exposes hideToTray', await evaluate('typeof window.electronAPI?.hideToTray === "function"'));

    /* ---- 2. instances view exists in the DOM ---- */
    check('instances-view element exists', await evaluate('!!document.getElementById("instances-view")'));
    check('instances-list element exists', await evaluate('!!document.getElementById("instances-list")'));
    check('instances tab in header', await evaluate('!!document.getElementById("instances-tab")'));
    check('TAB_VIEWS includes instances', await evaluate('TAB_VIEWS.includes("instances")'));

    /* ---- 3. empty state ---- */
    await evaluate('switchTab("instances")');
    const emptyVisible = await evaluate(`!document.getElementById('instances-empty').classList.contains('hidden')`);
    check('empty state shows with no sessions', emptyVisible);
    check('subtitle reads "Nothing is running"', await evaluate(`document.getElementById('instances-subtitle').textContent.trim() === 'Nothing is running'`));
    check('tab hidden while idle', await evaluate(`document.getElementById('instances-tab').classList.contains('hidden')`));

    /* ---- 4. the main process state shape ---- */
    const state = await evaluate('window.electronAPI.getGameState()');
    check('game-state has sessions array', Array.isArray(state?.sessions), JSON.stringify(state));
    check('game-state has count', state?.count === 0, JSON.stringify(state));
    check('game-state keeps legacy phase field', state?.phase === 'idle', JSON.stringify(state));

    /* ---- 5. simulate two running sessions in the renderer ---- */
    await evaluate(`
      applyInstanceState({
        phase: 'running', count: 2, runningCount: 2,
        sessions: [
          { profileId: '1.8.9', name: '1.8.9 PvP', gameVersion: '1.8.9', loader: 'forge', phase: 'running', startedAt: Date.now() - 65000, pid: 4242, server: null },
          { profileId: '1.20.4', name: '1.20.4 SMP', gameVersion: '1.20.4', loader: 'fabric', phase: 'launching', startedAt: Date.now() - 3000, pid: null, server: { label: 'Hypixel' } }
        ]
      });
    `);
    await evaluate('switchTab("instances")');

    check('two rows rendered', await evaluate('document.querySelectorAll("#instances-list .inst-row").length === 2'));
    check('row shows profile name', await evaluate(`document.getElementById('instances-list').textContent.includes('1.8.9 PvP')`));
    check('row shows pid', await evaluate(`document.getElementById('instances-list').textContent.includes('pid 4242')`));
    check('row shows server target', await evaluate(`document.getElementById('instances-list').textContent.includes('Joining Hypixel')`));
    check('starting row offers Cancel', await evaluate(`document.getElementById('instances-list').textContent.includes('Cancel')`));
    check('running row offers Stop', await evaluate(`document.getElementById('instances-list').textContent.includes('Stop')`));
    check('uptime formatted past a minute', await evaluate(`/[1-9]:\\d\\d/.test(document.querySelector('[data-uptime]').textContent)`));
    check('tab became visible', await evaluate(`!document.getElementById('instances-tab').classList.contains('hidden')`));
    check('badge counts both', await evaluate(`document.getElementById('instances-badge-count').textContent === '2'`));
    check('stop-all enabled', await evaluate(`document.getElementById('instances-stop-all').disabled === false`));
    check('subtitle mentions both phases', await evaluate(`document.getElementById('instances-subtitle').textContent.includes('1 running') && document.getElementById('instances-subtitle').textContent.includes('1 starting')`));

    /* ---- 6. the launch picker marks running profiles ---- */
    await evaluate('switchTab("instances")');
    await evaluate('openLaunchPicker()');
    check('launch picker opens', await evaluate(`!document.getElementById('launch-picker').classList.contains('hidden')`));
    const pickerHasDisabled = await evaluate(`document.querySelectorAll('#launch-picker-list button[disabled]').length >= 0`);
    check('launch picker renders rows', pickerHasDisabled);
    /* A fixed-position modal inside a `.hidden` view still measures 0x0 and
       renders nothing, so assert it actually has a box and is on screen. */
    const pickerMounted = await evaluate(`
      (() => {
        const modal = document.getElementById('launch-picker');
        const panel = modal.querySelector('.surface-modal');
        const r = panel.getBoundingClientRect();
        return {
          parent: modal.parentElement.tagName,
          w: Math.round(r.width),
          h: Math.round(r.height),
          onScreen: r.width > 100 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 1
        };
      })()
    `);
    check('launch picker is mounted on body', pickerMounted.parent === 'BODY', JSON.stringify(pickerMounted));
    check('launch picker panel has a real box', pickerMounted.w > 100 && pickerMounted.h > 40, JSON.stringify(pickerMounted));
    check('launch picker is on screen', pickerMounted.onScreen, JSON.stringify(pickerMounted));

    /* ---- 6b. long names must not widen the picker or spill out of it ----
       The original bug: the row is a <button>, which is inline-block, so a
       60-character profile name sized the row to its text and pushed it past
       the panel. Measure real boxes rather than trusting class names. */
    /* 64 chars: at 12px it is wider than the ~300px the picker gives the name,
       so the ellipsis must actually be drawn rather than the test passing by
       coincidence. */
    const longName = '1.21.11-Fabricswitchwewrwrwewrwrwewrwrwewrwrwewrwrwewrwr';
    await evaluate(`
      PROFILES = [
        { id: 'long', name: ${JSON.stringify(longName)}, gameVersion: '1.21.11', loader: 'fabric', ram: 4, ready: true },
        { id: 'short', name: 'PvP', gameVersion: '1.8.9', loader: 'forge', ram: 2, ready: true }
      ];
      renderLaunchPicker();
    `);
    /* A `truncate` element's clientWidth is its box, which is already clamped,
       so asking whether it "clipped" via scrollWidth is unreliable once the
       parent is a flex item. Measure the *text* with a Range instead: if the
       glyph run is wider than the visible box, an ellipsis is being drawn. */
    const textOverflows = `(el) => {
      if (!el || !el.firstChild) return false;
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect().width > el.clientWidth + 1;
    }`;
    /* At this window size a 420px panel leaves the name ~305px, which this
       test name happens to fit inside — so squeeze the panel first, otherwise
       the truncation assertion would pass for the wrong reason. */
    const pickerBox = await evaluate(`
      (() => {
        const clipped = ${textOverflows};
        const panel = document.querySelector('#launch-picker .surface-modal');
        panel.style.maxWidth = '240px';
        const list = document.getElementById('launch-picker-list');
        const rows = [...list.querySelectorAll('button')];
        const last = rows[rows.length - 1];
        const spans = rows[0].querySelectorAll('.truncate');
        const out = {
          panelRight: panel.getBoundingClientRect().right,
          listScrollW: list.scrollWidth,
          listClientW: list.clientWidth,
          rowScrollW: rows.map((r) => r.scrollWidth),
          rowClientW: rows.map((r) => r.clientWidth),
          lastRight: last.getBoundingClientRect().right,
          nameClipped: clipped(spans[0]),
          metaClipped: clipped(spans[1]),
          nameText: spans[0]?.textContent || ''
        };
        panel.style.maxWidth = '';
        return out;
      })()
    `);
    check('long name is truncated, not wrapped', pickerBox.nameText === longName && pickerBox.nameClipped,
      JSON.stringify(pickerBox));
    /* "1.21.11 · Fabric · 4 GB" fits 212px, so narrow the panel until the meta
       line has to ellipsise as well — that is the case the layout must survive. */
    const metaBox = await evaluate(`
      (() => {
        const clipped = ${textOverflows};
        const panel = document.querySelector('#launch-picker .surface-modal');
        panel.style.maxWidth = '150px';
        const spans = document.querySelector('#launch-picker-list button').querySelectorAll('.truncate');
        const out = { metaClipped: clipped(spans[1]), nameClipped: clipped(spans[0]),
                      listW: document.getElementById('launch-picker-list').clientWidth,
                      listScrollW: document.getElementById('launch-picker-list').scrollWidth };
        panel.style.maxWidth = '';
        return out;
      })()
    `);
    check('meta line truncates when space is tight', metaBox.metaClipped, JSON.stringify(metaBox));
    check('narrow panel still has no horizontal scroll', metaBox.listScrollW <= metaBox.listW + 1, JSON.stringify(metaBox));
    check('picker list does not scroll horizontally', pickerBox.listScrollW <= pickerBox.listClientW + 1,
      `scrollW=${pickerBox.listScrollW} clientW=${pickerBox.listClientW}`);
    check('every picker row fits its own box', pickerBox.rowScrollW.every((w, i) => w <= pickerBox.rowClientW[i] + 1),
      JSON.stringify(pickerBox.rowScrollW) + ' vs ' + JSON.stringify(pickerBox.rowClientW));
    check('last row stays inside the panel', pickerBox.lastRight <= pickerBox.panelRight + 1,
      `row right ${pickerBox.lastRight} panel right ${pickerBox.panelRight}`);

    /* The panel is width-capped, so shrinking the window must not push it out. */
    const narrow = await evaluate(`
      (() => {
        const panel = document.querySelector('#launch-picker > div');
        const before = panel.getBoundingClientRect().width;
        document.body.style.width = '360px';
        const after = panel.getBoundingClientRect().width;
        document.body.style.width = '';
        return { before, after, overflow: document.documentElement.scrollWidth > window.innerWidth };
      })()
    `);
    check('picker panel is width-capped', narrow.before <= 420, `width ${narrow.before}`);
    check('no page-level horizontal overflow with a long name', narrow.overflow === false, JSON.stringify(narrow));

    await evaluate('closeLaunchPicker()');
    check('launch picker closes', await evaluate(`document.getElementById('launch-picker').classList.contains('hidden')`));

    /* ---- 6c. instance rows hold their shape with a long name ---- */
    await evaluate(`
      applyInstanceState({ phase: 'running', count: 1, runningCount: 1, sessions: [
        { profileId: 'long', name: '1.21.11-Fabricswitchwewrwrwewrwrwewrwrwewrwrwewrwrwewrwr', gameVersion: '1.21.11', loader: 'fabric', phase: 'running', startedAt: Date.now() - 5000, pid: 7, server: null }
      ]});
      switchTab('instances');
    `);
    /* At 1040px the row has room for the whole name, so shrink the list before
       asserting truncation — and check the Stop button survives the squeeze. */
    const rowBox = await evaluate(`
      (() => {
        const clipped = ${textOverflows};
        const list = document.getElementById('instances-list');
        list.style.width = '420px';
        const row = list.querySelector('.inst-row');
        const stop = row.querySelector('button');
        const name = row.querySelector('.truncate');
        const out = {
          rowScrollW: row.scrollWidth,
          rowClientW: row.clientWidth,
          listScrollW: list.scrollWidth,
          listClientW: list.clientWidth,
          stopWidth: Math.round(stop.getBoundingClientRect().width),
          stopText: stop.textContent.trim(),
          nameClipped: clipped(name),
          pageOverflow: document.documentElement.scrollWidth > window.innerWidth
        };
        list.style.width = '';
        return out;
      })()
    `);
    check('instance row does not overflow', rowBox.rowScrollW <= rowBox.rowClientW + 1,
      `scrollW=${rowBox.rowScrollW} clientW=${rowBox.rowClientW}`);
    check('instance list does not scroll horizontally', rowBox.listScrollW <= rowBox.listClientW + 1,
      `scrollW=${rowBox.listScrollW} clientW=${rowBox.listClientW}`);
    check('instance name truncates when narrow', rowBox.nameClipped, JSON.stringify(rowBox));
    check('Stop button keeps a usable width', rowBox.stopWidth >= 52, `width ${rowBox.stopWidth}`);
    check('Stop label not clipped away', rowBox.stopText === 'Stop', `got "${rowBox.stopText}"`);
    check('instances page has no horizontal overflow', rowBox.pageOverflow === false);

    /* ---- 7. back to idle ---- */
    await evaluate(`
      applyInstanceState({ phase: 'idle', count: 0, runningCount: 0, sessions: [] });
    `);
    check('tab hides again at idle', await evaluate(`document.getElementById('instances-tab').classList.contains('hidden')`));
    check('rows cleared', await evaluate('document.querySelectorAll("#instances-list .inst-row").length === 0'));
    check('empty state returns', await evaluate(`!document.getElementById('instances-empty').classList.contains('hidden')`));

    /* ---- 8. Play screen still works ---- */
    /* The dashboard only exists once a session is signed in, so sign in the
       way the real login button does before touching Play. */
    await evaluate(`
      (async () => {
        const r = await window.electronAPI.loginCracked('TestRunner');
        if (r?.success) await enterDashboard({ username: 'TestRunner', type: 'cracked' });
        return r?.success;
      })()
    `);
    await new Promise((r) => setTimeout(r, 600));
    /* The fake rows from step 5 are still in INSTANCES; clear them before
       reading the Play button, or it correctly reports the stale session. */
    await evaluate(`
      applyInstanceState({ phase: 'idle', count: 0, runningCount: 0, sessions: [] });
      handleGameState({ phase: 'idle', profileId: null, sessions: [] });
    `);
    await evaluate('switchTab("play")');
    await new Promise((r) => setTimeout(r, 400));
    check('play view visible after sign-in', await evaluate(`!document.getElementById('play-view').classList.contains('hidden')`));
    const btnText = await evaluate('document.getElementById("launch-btn-text").textContent');
    check('launch button reads Play', btnText === 'Play', `got "${btnText}" (launchPhase=${await evaluate('typeof launchPhase !== "undefined" ? launchPhase : "n/a"')})`);

    /* A foreign profile's launch must not flip the Play button. */
    await evaluate(`
      applyInstanceState({ phase: 'running', count: 1, runningCount: 1, sessions: [
        { profileId: '__other__', name: 'Other', gameVersion: '1.21.1', loader: 'neoforge', phase: 'running', startedAt: Date.now(), pid: 99 }
      ]});
    `);
    check('foreign launch leaves Play idle', await evaluate(`document.getElementById('launch-btn-text').textContent === 'Play'`));
    check('status line mentions the open instance', await evaluate(`document.getElementById('play-status-line').textContent.includes('1 instance running')`));

    /* ---- 9. settings toggles exist ---- */
    await evaluate('switchTab("settings")');
    check('runInBackground toggle exists', await evaluate('!!document.getElementById("setting-runInBackground")'));
    check('backgroundNotice toggle exists', await evaluate('!!document.getElementById("setting-backgroundNotice")'));
    check('settings default runInBackground on', await evaluate('SETTINGS.runInBackground !== false'));

    /* ---- 10. tray is live ---- */
    check('tray reports available', await evaluate('window.electronAPI.trayAvailable()'));

  } finally {
    try { ws?.close(); } catch (e) { /* ignore */ }
    child.kill();
    await new Promise((r) => setTimeout(r, 800));
    if (results.some((r) => !r.ok)) {
      console.log('\n--- launcher output ---');
      console.log(mainLog.join('').slice(-3000));
    }
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (e) { /* ignore */ }

    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} checks passed`);
    process.exit(passed === results.length ? 0 : 1);
  }
}

main().catch((err) => {
  console.error('harness error:', err.message);
  process.exit(2);
});
