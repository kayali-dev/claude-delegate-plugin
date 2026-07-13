import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { brokerError, normalizeBrokerError } from './errors.mjs';
import { terminateProcessTree } from './process.mjs';

export class JsonRpcProcess {
  constructor(command, args, options = {}) {
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.onNotification = options.onNotification || (() => {});
    this.onRequest = options.onRequest || (async () => { throw brokerError('INVALID_REQUEST', 'Unsupported server request'); });
    this.onStderr = options.onStderr || (() => {});
    this.requestTimeoutMs = Number(options.requestTimeoutMs || process.env.DELEGATE_RPC_TIMEOUT_MS || 30000);
    this.child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on('line', (line) => this.#receive(line));
    this.child.stderr.on('data', (chunk) => this.onStderr(String(chunk)));
    this.exit = new Promise((resolve) => {
      this.child.once('error', (error) => this.#finish({ error }));
      this.child.once('exit', (code, signal) => this.#finish({ code, signal }));
      this._resolveExit = resolve;
    });
  }

  #send(message) {
    if (this.closed) throw brokerError('TRANSPORT_ERROR', 'JSON-RPC process is closed');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async #receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id != null && (message.result !== undefined || message.error)) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (pending.timer) clearTimeout(pending.timer);
      if (message.error) {
        const error = brokerError('PROVIDER_ERROR', message.error.message || JSON.stringify(message.error), {
          rpcCode: message.error.code,
          data: message.error.data
        });
        pending.reject(error);
      } else pending.resolve(message.result);
      return;
    }
    if (message.method && message.id != null) {
      try {
        const result = await this.onRequest(message.method, message.params || {});
        this.#send({ jsonrpc: '2.0', id: message.id, result });
      } catch (error) {
        this.#send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error.message } });
      }
      return;
    }
    if (message.method) await this.onNotification(message.method, message.params || {});
  }

  #finish(outcome) {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    const error = outcome.error
      ? normalizeBrokerError(outcome.error, { defaultCode: 'TRANSPORT_ERROR' })
      : brokerError('TRANSPORT_ERROR', `JSON-RPC process exited with code ${outcome.code}${outcome.signal ? ` (${outcome.signal})` : ''}`);
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this._resolveExit?.(outcome);
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, timer: null };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          if (!this.pending.delete(String(id))) return;
          const error = brokerError('RPC_TIMEOUT', `JSON-RPC request timed out after ${timeoutMs}ms: ${method}`);
          reject(error);
        }, timeoutMs);
        pending.timer.unref?.();
      }
      this.pending.set(String(id), pending);
      try { this.#send({ jsonrpc: '2.0', id, method, params }); }
      catch (error) {
        this.pending.delete(String(id));
        if (pending.timer) clearTimeout(pending.timer);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.#send({ jsonrpc: '2.0', method, params });
  }

  async stop() {
    if (this.closed) return;
    try { this.child.stdin.end(); } catch {}
    await terminateProcessTree(this.child);
  }
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
