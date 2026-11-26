/* Live Minecraft status over the Server List Ping protocol. Pure Node, no
   Electron imports, so it can be exercised from the command line. */

const dns = require('dns');
const net = require('net');

const DEFAULT_PORT = 25565;
const PROTOCOL = 769;
const TIMEOUT_MS = 4500;
const LIVE_TTL = 45 * 1000;
const OFFLINE_TTL = 20 * 1000;
const MAX_HOSTS = 60;
const MAX_RESPONSE = 128 * 1024;

const cache = new Map();

function varint(value) {
  const bytes = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest > 0) byte |= 0x80;
    bytes.push(byte);
  } while (rest > 0);
  return Buffer.from(bytes);
}

function varintString(value) {
  const bytes = Buffer.from(String(value), 'utf8');
  return Buffer.concat([varint(bytes.length), bytes]);
}

function packet(id, payload) {
  const body = Buffer.concat([varint(id), payload]);
  return Buffer.concat([varint(body.length), body]);
}

function readVarint(buffer, offset) {
  let result = 0;
  let size = 0;
  for (;;) {
    if (offset + size >= buffer.length) return null;
    const byte = buffer[offset + size];
    result += (byte & 0x7f) * 2 ** (7 * size);
    size += 1;
    if (size > 5) throw new Error('Malformed packet.');
    if ((byte & 0x80) === 0) return { value: result, size };
  }
}

function takeFrame(buffer) {
  const head = readVarint(buffer, 0);
  if (!head) return null;
  if (head.value > MAX_RESPONSE) throw new Error('Server sent an oversized response.');
  const end = head.size + head.value;
  if (buffer.length < end) return null;
  return buffer.subarray(head.size, end);
}

function statusFromFrame(frame) {
  const id = readVarint(frame, 0);
  if (!id || id.value !== 0) throw new Error('Unexpected packet.');
  const length = readVarint(frame, id.size);
  if (!length) throw new Error('Truncated packet.');
  const start = id.size + length.size;
  if (start + length.value > frame.length) throw new Error('Truncated packet.');
  return JSON.parse(frame.subarray(start, start + length.value).toString('utf8'));
}

function splitAddress(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (net.isIP(raw)) return { host: raw, port: DEFAULT_PORT, explicit: false };

  const bracketed = raw.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/);
  if (bracketed) {
    const port = Number(bracketed[2]);
    return { host: bracketed[1], port: port >= 1 && port <= 65535 ? port : DEFAULT_PORT, explicit: Boolean(bracketed[2]) };
  }

  const plain = raw.match(/^([^:\s]+)(?::(\d{1,5}))?$/);
  if (!plain) return null;
  const port = Number(plain[2]);
  return { host: plain[1], port: port >= 1 && port <= 65535 ? port : DEFAULT_PORT, explicit: Boolean(plain[2]) };
}

async function resolveTarget(address) {
  const parsed = splitAddress(address);
  if (!parsed) throw new Error('Invalid address.');
  if (parsed.explicit || net.isIP(parsed.host)) return parsed;

  try {
    const records = await dns.promises.resolveSrv(`_minecraft._tcp.${parsed.host}`);
    if (records && records.length) {
      records.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
      return { host: records[0].name, port: records[0].port || DEFAULT_PORT, explicit: true };
    }
  } catch (err) {
    /* Most networks have no SRV record and listen on the default port. */
  }
  return parsed;
}

async function query(address) {
  const target = await resolveTarget(address);

  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: target.host, port: target.port });
    let settled = false;
    let buffer = Buffer.alloc(0);
    let sentAt = 0n;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => finish(new Error('Server did not answer.')), TIMEOUT_MS);

    socket.setNoDelay(true);

    socket.on('connect', () => {
      const handshake = Buffer.concat([
        varint(PROTOCOL),
        varintString(target.host),
        Buffer.from([(target.port >> 8) & 0xff, target.port & 0xff]),
        varint(1)
      ]);
      socket.write(packet(0x00, handshake));
      sentAt = process.hrtime.bigint();
      socket.write(packet(0x00, Buffer.alloc(0)));
    });

    socket.on('data', (chunk) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      if (buffer.length > MAX_RESPONSE) {
        finish(new Error('Server sent an oversized response.'));
        return;
      }

      try {
        const frame = takeFrame(buffer);
        if (!frame) return;
        const status = statusFromFrame(frame);
        const players = Number(status?.players?.online);
        const max = Number(status?.players?.max);
        const favicon = typeof status?.favicon === 'string'
          && /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(status.favicon)
          && status.favicon.length <= 60000
          ? status.favicon
          : '';
        finish(null, {
          online: true,
          players: Number.isFinite(players) ? players : null,
          max: Number.isFinite(max) ? max : null,
          favicon,
          version: typeof status?.version?.name === 'string' ? status.version.name.slice(0, 40) : '',
          ping: Math.max(1, Math.round(Number(process.hrtime.bigint() - sentAt) / 1e6))
        });
      } catch (err) {
        finish(err);
      }
    });

    socket.on('error', (err) => finish(err));
    socket.on('close', () => finish(new Error('Connection closed.')));
  });
}

function statusOf(address) {
  const key = String(address || '').trim().toLowerCase();
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now < hit.expires) return hit.promise;

  const entry = { expires: now + TIMEOUT_MS + 1000, promise: null };
  entry.promise = query(address)
    .catch((err) => ({ online: false, error: String(err?.message || 'Unreachable.').slice(0, 80) }))
    .then((value) => {
      entry.expires = Date.now() + (value.online ? LIVE_TTL : OFFLINE_TTL);
      return value;
    });

  cache.set(key, entry);
  if (cache.size > 200) {
    for (const old of cache.keys()) {
      if (cache.size <= 150) break;
      cache.delete(old);
    }
  }

  return entry.promise;
}

async function statuses(addresses) {
  const unique = new Map();
  for (const value of Array.isArray(addresses) ? addresses : []) {
    const address = String(value || '').trim();
    if (address) unique.set(address.toLowerCase(), address);
  }

  const list = [...unique.values()].slice(0, MAX_HOSTS);
  const entries = await Promise.all(list.map(async (address) => [address, await statusOf(address)]));
  return Object.fromEntries(entries);
}

module.exports = { statuses, statusOf };
