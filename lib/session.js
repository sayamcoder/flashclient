const { app } = require('electron');
const fs = require('fs');
const path = require('path');

/* Only offline (local) accounts are remembered between restarts. A Microsoft
   session is a live bearer token; it is never written to disk. */
let cache = null;

function file() {
  return path.join(app.getPath('userData'), 'session.json');
}

function load() {
  if (cache !== null) return cache;
  try {
    const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
    const valid = saved?.type === 'cracked' && saved.username && saved.uuid;
    cache = valid ? { ...saved, accessToken: '0' } : null;
  } catch (err) {
    cache = null;
  }
  return cache;
}

function save(account) {
  cache = { type: 'cracked', username: account.username, uuid: account.uuid, accessToken: '0' };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
  return cache;
}

function clear() {
  cache = null;
  fs.rmSync(file(), { force: true });
}

module.exports = { load, save, clear, file };
