const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { rulesAllow } = require('./minecraft');

/* Offline accounts need the same UUID Minecraft itself would generate, or the
   level data and skin lookups disagree with the name. */
function offlineUuid(name) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function substitute(value, vars) {
  return String(value).replace(/\$\{([^}]+)\}/g, (match, key) => (
    vars[key] !== undefined ? vars[key] : match
  ));
}

function flatten(list, vars) {
  const out = [];
  for (const item of list || []) {
    if (typeof item === 'string') {
      out.push(substitute(item, vars));
      continue;
    }
    if (!rulesAllow(item.rules)) continue;
    const values = Array.isArray(item.value) ? item.value : [item.value];
    for (const value of values) out.push(substitute(value, vars));
  }
  return out;
}

function buildArguments(spec, account, ram, server) {
  const json = spec.json;
  const classpath = [...spec.classpath, spec.clientJar].join(';');

  const vars = {
    auth_player_name: account.username,
    version_name: spec.versionId,
    game_directory: spec.gameDir,
    assets_root: spec.assetsDir,
    assets_index_name: spec.assetIndex,
    auth_uuid: account.uuid,
    auth_access_token: account.accessToken,
    auth_session: account.accessToken,
    user_type: account.type === 'microsoft' ? 'msa' : 'legacy',
    version_type: 'release',
    user_properties: '{}',
    clientid: 'flashclient',
    auth_xuid: '',
    launcher_name: 'FlashClient',
    launcher_version: '1.0.4',
    natives_directory: spec.nativesDir,
    library_directory: spec.librariesDir,
    classpath,
    classpath_separator: ';'
  };

  const jvm = [`-Xmx${ram}G`, `-Xms${Math.max(1, Math.floor(ram / 2))}G`];

  if (Array.isArray(json.arguments?.jvm) && json.arguments.jvm.length) {
    jvm.push(...flatten(json.arguments.jvm, vars));
  } else {
    jvm.push(
      `-Djava.library.path=${spec.nativesDir}`,
      `-Dminecraft.launcher.brand=FlashClient`,
      `-Dminecraft.launcher.version=1.0.4`,
      '-cp',
      classpath
    );
  }

  let game;
  if (Array.isArray(json.arguments?.game) && json.arguments.game.length) {
    game = flatten(json.arguments.game, vars);
  } else {
    game = String(json.minecraftArguments || '')
      .split(' ')
      .filter(Boolean)
      .map((token) => substitute(token, vars));
  }

  // The skin file is keyed to this name; make sure the game is told even if a
  // version manifest leaves the argument out.
  if (!game.includes('--username')) game.push('--username', account.username);

  // Quick play hands the server to the game the same way the vanilla launcher does.
  if (server?.host) {
    game.push('--server', server.host);
    if (server.port) game.push('--port', String(server.port));
  }

  return [...jvm, json.mainClass, ...game];
}

/* Windows reports a runtime it cannot start as "spawn <path> UNKNOWN", which
   tells nobody anything. Each code gets a sentence the player can act on. */
function startupError(code, javaPath) {
  const target = javaPath || 'the selected Java runtime';
  if (code === 'ENOENT') return `Java is missing at ${target}. Let the launcher install it again.`;
  if (code === 'EACCES') return `Windows blocked ${target} from starting. Check antivirus or run the launcher as administrator.`;
  if (code === 'UNKNOWN' || code === 'EINVAL') {
    return `Windows could not start ${target}. That Java runtime looks broken or incomplete — installing it again usually fixes this.`;
  }
  return `Java could not start (${code || 'unknown error'}).`;
}

function launchGame({ spec, account, ram, server, onLog, onExit }) {
  const gameDir = spec.gameDir;
  const javaPath = spec?.java?.path;

  fs.mkdirSync(path.join(gameDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(gameDir, 'mods'), { recursive: true });

  const args = buildArguments(spec, account, ram, server);

  // Written synchronously before spawn so a runtime Windows refuses to start
  // still leaves a log, even though spawn throws before any async I/O runs.
  const logFile = path.join(gameDir, 'logs', 'launcher-latest.log');
  fs.writeFileSync(logFile, `${new Date().toISOString()}\n${javaPath || '(no runtime)'} ${args.join(' ')}\n\n`);
  const stream = fs.createWriteStream(logFile, { flags: 'a' });
  stream.on('error', () => { /* logging must never take the launch down */ });

  const failed = (message, code) => {
    try {
      fs.appendFileSync(logFile, `\n${message}\n`);
      stream.end();
    } catch (writeErr) { /* best effort */ }
    const failure = new Error(message);
    if (code) failure.code = code;
    return failure;
  };

  if (!javaPath) throw failed('No Java runtime is available for this profile.');

  try {
    if (!fs.statSync(javaPath).isFile()) throw failed(startupError('UNKNOWN', javaPath), 'UNKNOWN');
  } catch (err) {
    if (err.code === 'ENOENT') throw failed(startupError('ENOENT', javaPath), 'ENOENT');
    throw err;
  }

  let child;
  try {
    child = spawn(javaPath, args, {
      cwd: gameDir,
      windowsHide: true,
      env: { ...process.env }
    });
  } catch (err) {
    const code = String(err?.code || '').toUpperCase();
    throw failed(startupError(code, javaPath), code);
  }

  // The caller waits on this so a runtime Windows refuses to start is handled
  // (and retried) before the UI claims the game is running.
  let spawned = false;
  const ready = new Promise((resolve, reject) => {
    child.once('spawn', () => {
      spawned = true;
      resolve();
    });
    child.once('error', (err) => {
      const code = String(err?.code || '').toUpperCase();
      if (!spawned) {
        reject(failed(startupError(code, javaPath), code));
        return;
      }
      onExit?.({ code: -1, error: startupError(code, javaPath) });
    });
  });

  const pipe = (chunk) => {
    const text = chunk.toString();
    stream.write(text);
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) onLog?.(line);
    }
  };

  child.stdout.on('data', pipe);
  child.stderr.on('data', pipe);

  let exited = false;
  child.on('exit', (code, signal) => {
    exited = true;
    stream.end();
    onExit?.({ code, signal });
  });

  return {
    process: child,
    args,
    ready,
    stop() {
      if (exited) return;
      child.kill();
      setTimeout(() => {
        if (!exited) {
          try {
            spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
          } catch (err) {
            // best effort
          }
        }
      }, 4000);
    },
    isRunning() {
      return !exited;
    }
  };
}

module.exports = { launchGame, offlineUuid, buildArguments };
