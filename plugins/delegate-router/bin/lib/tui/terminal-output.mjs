import { format as formatConsole } from 'node:util';
import { stripAnsi } from './width.mjs';

function cleanLine(value) {
  return stripAnsi(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trimEnd();
}

export class TerminalOutputCapture {
  constructor(options = {}) {
    this.stdout = options.stdout || process.stdout;
    this.stderr = options.stderr || process.stderr;
    this.console = options.console || console;
    this.process = options.process || process;
    this.limit = Math.max(1, Number(options.limit || 100));
    this.now = options.now || (() => Date.now());
    this.onEntry = options.onEntry || (() => {});
    this.entries = [];
    this.pending = { stdout: '', stderr: '' };
    this.active = false;
    this.stopped = false;
    this.originalStdoutWrite = this.stdout.write;
    this.originalStderrWrite = this.stderr.write;
    this.realStdoutWrite = (...args) => this.originalStdoutWrite.call(this.stdout, ...args);
    this.realStderrWrite = (...args) => this.originalStderrWrite.call(this.stderr, ...args);
    this.originalConsole = Object.fromEntries(['log', 'info', 'debug', 'warn', 'error'].map((name) => [name, this.console[name]]));
    this.boundWarning = (warning) => this.capture('stderr', `[warning] ${warning?.name || 'Warning'}: ${warning?.message || ''}\n`);
    this.stdoutFacade = Object.create(this.stdout);
    Object.defineProperty(this.stdoutFacade, 'columns', { get: () => this.stdout.columns });
    Object.defineProperty(this.stdoutFacade, 'rows', { get: () => this.stdout.rows });
    this.stdoutFacade.write = (value, ...args) => this.realStdoutWrite(value, ...args);
    this.stderrFacade = Object.create(this.stderr);
    this.stderrFacade.write = (value, ...args) => this.active
      ? this.capture('stderr', value, ...args)
      : this.realStderrWrite(value, ...args);
  }

  push(stream, text) {
    const cleaned = cleanLine(text);
    if (!cleaned) return;
    const entry = Object.freeze({ at: this.now(), stream, text: cleaned });
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    try { this.onEntry(entry); } catch {}
  }

  capture(stream, value, encoding, callback) {
    const text = Buffer.isBuffer(value) ? value.toString(typeof encoding === 'string' ? encoding : 'utf8') : String(value ?? '');
    const combined = this.pending[stream] + text;
    const lines = combined.split(/\r?\n/);
    this.pending[stream] = lines.pop() || '';
    for (const line of lines) this.push(stream, line);
    const done = typeof encoding === 'function' ? encoding : typeof callback === 'function' ? callback : null;
    if (done) queueMicrotask(done);
    return true;
  }

  flush() {
    for (const stream of ['stdout', 'stderr']) {
      if (this.pending[stream]) this.push(stream, this.pending[stream]);
      this.pending[stream] = '';
    }
  }

  resume() {
    if (this.stopped || this.active) return false;
    this.active = true;
    const self = this;
    this.stdout.write = function capturedStdout(value, encoding, callback) { return self.capture('stdout', value, encoding, callback); };
    this.stderr.write = function capturedStderr(value, encoding, callback) { return self.capture('stderr', value, encoding, callback); };
    for (const name of ['log', 'info', 'debug']) this.console[name] = (...args) => this.capture('stdout', `${formatConsole(...args)}\n`);
    for (const name of ['warn', 'error']) this.console[name] = (...args) => this.capture('stderr', `${formatConsole(...args)}\n`);
    this.process.on?.('warning', this.boundWarning);
    return true;
  }

  suspend() {
    if (!this.active) return false;
    this.flush();
    this.active = false;
    this.stdout.write = this.originalStdoutWrite;
    this.stderr.write = this.originalStderrWrite;
    for (const [name, original] of Object.entries(this.originalConsole)) this.console[name] = original;
    this.process.off?.('warning', this.boundWarning);
    return true;
  }

  stop() {
    this.suspend();
    this.stopped = true;
  }

  history(limit = 20) {
    return this.entries.slice(-Math.max(1, Number(limit || 20)));
  }
}
