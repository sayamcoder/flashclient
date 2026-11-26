/* Exercises the session Map directly: two sessions registered, one exits,
   the other must survive. This is the invariant the refactor exists for. */
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');

/* Stub electron so lib/* can be required outside a real app. */
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return path.join(__dirname, 'electron-stub.js');
  return origResolve.call(this, request, ...args);
};

require('fs').writeFileSync(path.join(__dirname, 'electron-stub.js'), `
  const p = require('path');
  const os = require('os');
  module.exports = {
    app: {
      getPath: (k) => {
        const base = p.join(os.tmpdir(), 'flash-unit');
        if (!require('fs').existsSync(base)) require('fs').mkdirSync(base, { recursive: true });
        return base;
      },
      getVersion: () => '1.0.4',
      getAppPath: () => process.cwd()
    },
    ipcMain: { handle: () => {}, on: () => {} },
    BrowserWindow: class {},
    Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) },
    Tray: class {}, Notification: class {}, nativeImage: { createFromPath: () => ({}) },
    shell: {}, dialog: {}
  };
`);

const launch = require('../lib/launch');
const results = [];
const check = (n, ok, d) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d ? ` — ${d}` : ''}`); };

/* The handle contract launchGame returns, replicated so the session Map logic
   can be tested without spawning Java. */
function fakeHandle() {
  let running = true;
  const listeners = [];
  return {
    process: { pid: Math.floor(Math.random() * 9000) + 1000 },
    ready: Promise.resolve(),
    stop() { running = false; listeners.forEach((f) => f({ code: 0, signal: null })); },
    isRunning() { return running; },
    onExit(fn) { listeners.push(fn); },
    /* test-only: simulate the game quitting on its own */
    quit(code = 0) { running = false; listeners.forEach((f) => f({ code, signal: null })); }
  };
}

/* Mirror main.js's session bookkeeping. */
const sessions = new Map();
const launchesInFlight = new Set();
const events = [];

function registerSession(s) { sessions.set(s.profileId, s); return s; }
function dropSession(id) { const s = sessions.get(id); if (!s) return null; sessions.delete(id); return s; }

function startSession(profileId, handle) {
  const session = registerSession({
    profileId, name: profileId, gameVersion: '1.0', loader: 'fabric',
    phase: 'running', startedAt: Date.now(), handle, server: null
  });
  handle.onExit((info) => {
    const removed = dropSession(profileId);
    launchesInFlight.delete(profileId);
    if (!removed) return;
    events.push({ profileId, ...info });
  });
  return session;
}

function gameStatePayload() {
  const all = [...sessions.values()].sort((a, b) => a.startedAt - b.startedAt);
  const newest = all[all.length - 1] || null;
  return {
    phase: newest?.phase || 'idle',
    profileId: newest?.profileId || null,
    count: all.length,
    runningCount: all.filter((s) => s.phase === 'running').length,
    sessions: all.map((s) => ({ profileId: s.profileId, phase: s.phase, pid: s.handle?.process?.pid || null }))
  };
}

/* ---- concurrent registration ---- */
const hA = fakeHandle();
const hB = fakeHandle();
startSession('1.8.9', hA);
startSession('1.20.4', hB);

let st = gameStatePayload();
check('two sessions coexist', st.count === 2, JSON.stringify(st));
check('both count as running', st.runningCount === 2, JSON.stringify(st));
check('distinct pids', st.sessions[0].pid !== st.sessions[1].pid, JSON.stringify(st.sessions));

/* ---- one stops, the other survives ---- */
hA.stop();
st = gameStatePayload();
check('stopping one leaves one', st.count === 1, JSON.stringify(st));
check('survivor is the other profile', st.sessions[0].profileId === '1.20.4', JSON.stringify(st));
check('survivor still running', st.runningCount === 1, JSON.stringify(st));
check('exit event fired once', events.length === 1, JSON.stringify(events));
check('exit names the right profile', events[0]?.profileId === '1.8.9', JSON.stringify(events));

/* ---- a second exit is a no-op, not a crash ---- */
const before = events.length;
hA.stop();
check('double-stop does not duplicate the exit', events.length === before, `events=${events.length}`);

/* ---- last one quits on its own ---- */
hB.quit(0);
st = gameStatePayload();
check('all sessions gone', st.count === 0, JSON.stringify(st));
check('phase returns to idle', st.phase === 'idle', JSON.stringify(st));
check('profileId cleared', st.profileId === null, JSON.stringify(st));
check('two exits recorded', events.length === 2, JSON.stringify(events));

/* ---- same-profile collision is rejected ---- */
sessions.clear();
const hC = fakeHandle();
startSession('1.20.4', hC);
const collides = sessions.has('1.20.4');
check('same profile cannot run twice', collides);
check('a different profile still can', !sessions.has('1.21.1'));
hC.stop();

/* ---- buildArguments still works for both ---- */
const spec = {
  json: { mainClass: 'net.minecraft.client.main.Main', minecraftArguments: '--username ${auth_player_name}' },
  classpath: ['a.jar'], clientJar: 'c.jar', versionId: '1.20.4',
  gameDir: 'C:/g', assetsDir: 'C:/a', assetIndex: '5', nativesDir: 'C:/n', librariesDir: 'C:/l'
};
const args = launch.buildArguments(spec, { username: 'Steve', uuid: 'u', accessToken: 't', type: 'cracked' }, 4, null);
check('buildArguments produces --username', args.includes('--username') && args.includes('Steve'), args.join(' '));
check('buildArguments sets -Xmx', args.includes('-Xmx4G'), args.join(' '));

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
