/* Minimal Discord RPC over the local IPC pipe. Discord ships no public Node
   client for this anymore, and the protocol is four bytes of header, so
   speaking it directly is less code than vendoring a dead dependency. */

const net = require('net');
const fs = require('fs');

const CLIENT_ID = '1569401644922306620';
const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

const PIPE_NAMES = process.platform === 'win32'
  ? Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`)
  : Array.from({ length: 10 }, (_, i) => `/tmp/discord-ipc-${i}`);

function pipeExists(name) {
  if (process.platform !== 'win32') return fs.existsSync(name);
  return fs.existsSync(name);
}

function frame(op, payload) {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const head = Buffer.alloc(8);
  head.writeUInt32LE(op, 0);
  head.writeUInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

class DiscordRpc {
  constructor() {
    this.socket = null;
    this.ready = false;
    this.enabled = true;
    this.activity = null;
    this.pending = Buffer.alloc(0);
    this.retryTimer = null;
    this.nonce = 0;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (this.enabled) this.connect();
    else this.disconnect();
  }

  connect() {
    if (!this.enabled || this.socket) return;

    const name = PIPE_NAMES.find(pipeExists);
    if (!name) {
      this.scheduleRetry();
      return;
    }

    const socket = net.createConnection(name);
    this.socket = socket;
    this.pending = Buffer.alloc(0);

    socket.on('connect', () => {
      socket.write(frame(OP_HANDSHAKE, { v: 1, client_id: CLIENT_ID }));
    });

    socket.on('data', (chunk) => this.onData(chunk));

    socket.on('error', () => {
      this.teardown();
    });

    socket.on('close', () => {
      this.teardown();
    });
  }

  onData(chunk) {
    this.pending = Buffer.concat([this.pending, chunk]);

    while (this.pending.length >= 8) {
      const op = this.pending.readUInt32LE(0);
      const length = this.pending.readUInt32LE(4);
      if (this.pending.length < 8 + length) return;

      const body = this.pending.subarray(8, 8 + length).toString('utf8');
      this.pending = this.pending.subarray(8 + length);

      if (op === OP_PING) {
        this.socket?.write(frame(OP_PONG, JSON.parse(body)));
        continue;
      }
      if (op !== OP_FRAME) continue;

      let message;
      try {
        message = JSON.parse(body);
      } catch (err) {
        continue;
      }

      // A READY event means the handshake landed; anything waiting can go out.
      if (message.evt === 'READY') {
        this.ready = true;
        if (this.activity) this.pushActivity(this.activity);
      }
    }
  }

  setActivity(activity) {
    this.activity = activity;
    if (!activity) {
      if (this.ready) this.sendCommand('SET_ACTIVITY', { pid: process.pid, activity: null });
      return;
    }
    if (this.ready) this.pushActivity(activity);
  }

  pushActivity(activity) {
    // Only game time gets a counter; sitting in the launcher should not read
    // as hours of play.
    this.sendCommand('SET_ACTIVITY', {
      pid: process.pid,
      activity
    });
  }

  sendCommand(cmd, args) {
    if (!this.socket || !this.ready) return;
    this.nonce += 1;
    this.socket.write(frame(OP_FRAME, { cmd, args, nonce: `${this.nonce}` }));
  }

  teardown() {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
    }
    this.socket = null;
    this.ready = false;
    this.scheduleRetry();
  }

  scheduleRetry() {
    if (!this.enabled || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, 15000);
    this.retryTimer.unref?.();
  }

  disconnect() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.write(frame(OP_CLOSE, {}));
      } catch (err) {
        // socket is already gone
      }
      this.socket.removeAllListeners();
      this.socket.destroy();
    }
    this.socket = null;
    this.ready = false;
  }
}

module.exports = { DiscordRpc };
