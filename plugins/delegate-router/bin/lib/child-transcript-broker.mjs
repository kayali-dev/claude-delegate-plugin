import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { dataDir } from './state.mjs';

const MAX_FRAME_BYTES = 256 * 1024;
const SOCKET_PREFIX = 'ct-';

function privateRoot() {
  return dataDir();
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function ensurePrivateRoot() {
  const root = privateRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(root, 0o700); } catch {}
  try {
    for (const name of fs.readdirSync(root)) {
      const match = name.match(/^ct-(\d+)-[a-f0-9]+\.sock$/);
      if (match && !processAlive(Number(match[1]))) {
        try { fs.unlinkSync(path.join(root, name)); } catch {}
      }
    }
  } catch {}
  return root;
}

function socketPath(subscriptionId) {
  const suffix = crypto.createHash('sha256').update(String(subscriptionId)).digest('hex').slice(0, 8);
  return path.join(ensurePrivateRoot(), `${SOCKET_PREFIX}${process.pid}-${suffix}.sock`);
}

function writeFrame(socket, value) {
  if (!socket || socket.destroyed) return false;
  const frame = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) return false;
  socket.write(frame);
  return true;
}

function framed(socket, onFrame, onError) {
  socket.setEncoding('utf8');
  let buffered = '';
  socket.on('data', (chunk) => {
    buffered += chunk;
    if (Buffer.byteLength(buffered) > MAX_FRAME_BYTES) {
      onError(new Error('child transcript frame exceeds the bounded transport limit'));
      socket.destroy();
      return;
    }
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      try { onFrame(JSON.parse(line)); }
      catch (error) { onError(error); socket.destroy(); return; }
    }
  });
}

export function removeChildTranscriptEndpoint(endpoint) {
  const root = path.resolve(privateRoot());
  const target = path.resolve(String(endpoint || ''));
  if (path.dirname(target) !== root || !path.basename(target).startsWith(SOCKET_PREFIX)) return false;
  try { fs.unlinkSync(target); return true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return false;
}

export class ChildTranscriptConsumer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.subscriptionId = options.subscriptionId || crypto.randomUUID();
    this.token = options.token || crypto.randomBytes(32).toString('hex');
    this.endpoint = options.endpoint || socketPath(this.subscriptionId);
    this.server = null;
    this.socket = null;
    this.authenticated = false;
    this.closed = false;
  }

  async start() {
    if (this.server) return this.descriptor();
    removeChildTranscriptEndpoint(this.endpoint);
    this.server = net.createServer((socket) => this.accept(socket));
    await new Promise((resolve, reject) => {
      const onError = (error) => { this.server.off('listening', onListening); reject(error); };
      const onListening = () => { this.server.off('error', onError); resolve(); };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.endpoint);
    });
    try { fs.chmodSync(this.endpoint, 0o600); } catch {}
    return this.descriptor();
  }

  descriptor() {
    return { subscriptionId: this.subscriptionId, token: this.token, endpoint: this.endpoint };
  }

  accept(socket) {
    if (this.closed || this.socket) { socket.destroy(); return; }
    this.socket = socket;
    let greeted = false;
    framed(socket, (message) => {
      if (!greeted) {
        greeted = true;
        if (message?.type !== 'hello'
          || !safeEqual(message.subscriptionId, this.subscriptionId)
          || !safeEqual(message.token, this.token)) {
          this.emit('rejected', new Error('child transcript publisher authentication failed'));
          socket.destroy();
          return;
        }
        this.authenticated = true;
        writeFrame(socket, { type: 'ready', subscriptionId: this.subscriptionId });
        this.emit('connected');
        return;
      }
      if (this.authenticated) this.emit('message', message);
    }, (error) => this.emit('warning', error));
    socket.once('close', () => {
      const wasAuthenticated = this.authenticated;
      this.socket = null;
      this.authenticated = false;
      if (!this.closed) this.emit('disconnect', { authenticated: wasAuthenticated });
    });
    socket.once('error', (error) => this.emit('warning', error));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.socket?.destroy();
    this.socket = null;
    if (this.server) this.server.close();
    this.server = null;
    removeChildTranscriptEndpoint(this.endpoint);
  }
}

export async function connectChildTranscriptPublisher(descriptor, options = {}) {
  const socket = net.createConnection(descriptor.endpoint);
  let ready = false;
  const publisher = new EventEmitter();
  publisher.send = (message) => ready && writeFrame(socket, message);
  publisher.close = () => socket.destroy();
  const connected = new Promise((resolve, reject) => {
    const fail = (error) => { if (!ready) reject(error); };
    socket.once('error', fail);
    socket.once('connect', () => writeFrame(socket, {
      type: 'hello', subscriptionId: descriptor.subscriptionId, token: descriptor.token
    }));
    framed(socket, (message) => {
      if (!ready && message?.type === 'ready' && safeEqual(message.subscriptionId, descriptor.subscriptionId)) {
        ready = true;
        socket.off('error', fail);
        resolve(publisher);
      }
    }, fail);
    socket.once('close', () => {
      if (!ready) reject(new Error('child transcript endpoint closed before authentication'));
      publisher.emit('disconnect');
    });
  });
  const timeoutMs = Math.max(100, Number(options.timeoutMs || 2000));
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('child transcript endpoint handshake timed out')), timeoutMs);
    timer.unref?.();
  });
  try { return await Promise.race([connected, timeout]); }
  catch (error) { socket.destroy(); throw error; }
}
