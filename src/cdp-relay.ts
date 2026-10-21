import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { chmod, mkdir, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { GoError } from './chatgpt-go.js';
import { StateStore, acquireLock } from './task-state.js';
import { PROJECT_BASE } from './version.js';

// Local relay that holds ONE DevTools connection to the owner's main Chrome.
// Chrome's chrome://inspect remote-debugging switch asks the owner to approve every
// new connection; the relay connects once per Chrome start, then serves any number of
// `go` runs over an owner-only Unix socket (newline-delimited JSON CDP messages).
// When Chrome restarts, the upstream closes and the relay exits; the next `go` starts
// a new relay, which asks for approval once.

const RELAY_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'repo-mcp', 'relay');
export const RELAY_SOCKET = path.join(RELAY_DIR, 'cdp.sock');
const RELAY_LOG = path.join(RELAY_DIR, 'relay.log');
const MAIN_PORT_FILE = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'DevToolsActivePort');
const APPROVAL_WAIT_MS = 5 * 60_000;

/** Browser-level WebSocket URL that the main Chrome publishes when remote debugging is on. */
export async function mainChromeEndpoint() {
  let text: string;
  try { text = await readFile(MAIN_PORT_FILE, 'utf8'); }
  catch { throw new GoError('BROWSER_UNAVAILABLE', 'Chrome remote debugging is off. Enable it in chrome://inspect/#remote-debugging.'); }
  const [port, wsPath] = text.trim().split('\n');
  if (!/^\d+$/.test(port ?? '') || !wsPath?.startsWith('/devtools/browser/')) throw new GoError('BROWSER_UNAVAILABLE', 'Unreadable DevToolsActivePort file.');
  return `ws://127.0.0.1:${port}${wsPath}`;
}

/** Run the relay in this process until Chrome closes the upstream connection. */
export async function runRelay(log: (line: string) => void = line => process.stderr.write(line + '\n')) {
  await mkdir(RELAY_DIR, { recursive: true, mode: 0o700 });
  await chmod(RELAY_DIR, 0o700);
  // One relay per owner: the lock is held from before probing until cleanup finishes,
  // so two starters can never both connect or unlink each other's socket.
  const store = await StateStore.open(RELAY_DIR);
  let lock;
  try { lock = await acquireLock(store, 'cdp-relay', 'cdp relay', { recoverStale: true }); }
  catch { log('relay already running'); return; }
  try {
    await serve(log);
  } finally {
    await rm(RELAY_SOCKET, { force: true });
    await lock.release();
  }
}

async function serve(log: (line: string) => void) {
  await rm(RELAY_SOCKET, { force: true });
  const endpoint = await mainChromeEndpoint();
  log(`connecting to Chrome; approve the remote-debugging prompt in Chrome (waits ${APPROVAL_WAIT_MS / 60_000} min)`);
  const upstream = new WebSocket(endpoint);
  // Install close handling at creation so a disconnect during startup is never missed.
  let closed = false;
  const closedPromise = new Promise<void>(resolve => {
    upstream.addEventListener('close', () => { closed = true; resolve(); });
    upstream.addEventListener('error', () => { closed = true; resolve(); });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new GoError('BROWSER_APPROVAL_TIMEOUT', 'Chrome did not approve the DevTools connection.')), APPROVAL_WAIT_MS);
      upstream.addEventListener('open', () => { clearTimeout(timer); resolve(); });
      void closedPromise.then(() => { clearTimeout(timer); reject(new GoError('BROWSER_UNAVAILABLE', 'Chrome refused or closed the DevTools connection.')); });
    });
  } catch (error) {
    // Close a still-connecting upstream before the caller releases the singleton lock.
    try { upstream.close(); } catch { /* already closed */ }
    throw error;
  }
  log('connected');

  let nextId = 0;
  const routes = new Map<number, { client: net.Socket; id: number }>();
  const clients = new Set<net.Socket>();
  upstream.onmessage = event => {
    const msg = JSON.parse(String(event.data)) as { id?: number };
    if (msg.id === undefined) return; // events are not used by the driver
    const route = routes.get(msg.id);
    if (!route) return;
    routes.delete(msg.id);
    if (!route.client.destroyed) route.client.write(JSON.stringify({ ...msg, id: route.id }) + '\n');
  };

  const server = net.createServer(client => {
    clients.add(client);
    let buffer = '';
    client.setEncoding('utf8');
    client.on('data', chunk => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const msg = JSON.parse(line) as { id: number; method: string; params?: unknown; sessionId?: string };
          if (!Number.isSafeInteger(msg.id) || typeof msg.method !== 'string') continue;
          const id = ++nextId;
          routes.set(id, { client, id: msg.id });
          upstream.send(JSON.stringify({ id, method: msg.method, params: msg.params ?? {}, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) }));
        } catch { client.destroy(); }
      }
    });
    client.on('close', () => {
      clients.delete(client);
      for (const [id, route] of routes) if (route.client === client) routes.delete(id);
    });
    client.on('error', () => client.destroy());
  });

  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(RELAY_SOCKET, resolve); });
    await chmod(RELAY_SOCKET, 0o600);
    if (!closed) {
      log(`listening on ${RELAY_SOCKET}`);
      await new Promise<void>(resolve => {
        void closedPromise.then(resolve);
        process.once('SIGTERM', resolve);
        process.once('SIGINT', resolve);
      });
    }
    log('upstream closed; relay exiting');
  } finally {
    for (const client of clients) client.destroy();
    server.close();
    try { upstream.close(); } catch { /* already closed */ }
  }
}

async function relayAlive() {
  return new Promise<boolean>(resolve => {
    const socket = net.createConnection(RELAY_SOCKET);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

/** Start the relay in the background if it is not running, then wait until it accepts connections. */
export async function ensureRelay(sleep: (ms: number) => Promise<void> = ms => new Promise<void>(r => setTimeout(r, ms))) {
  if (await relayAlive()) return;
  await mkdir(RELAY_DIR, { recursive: true, mode: 0o700 });
  const logFd = openSync(RELAY_LOG, 'a', 0o600);
  let spawnError: Error | undefined;
  const child = spawn(process.execPath, [...process.execArgv, path.join(PROJECT_BASE, 'scripts', 'chatgpt-run.ts'), 'cdp-relay'], {
    cwd: PROJECT_BASE, detached: true, stdio: ['ignore', logFd, logFd]
  });
  // Without a listener an async spawn failure (EAGAIN, ENOENT) would crash the driver.
  child.on('error', error => { spawnError = error; });
  child.unref();
  closeSync(logFd);
  const deadline = Date.now() + APPROVAL_WAIT_MS + 10_000;
  while (Date.now() < deadline) {
    await sleep(500);
    if (spawnError) throw new GoError('BROWSER_UNAVAILABLE', `Cannot start the CDP relay: ${spawnError.message}`);
    if (await relayAlive()) return;
    // Exit 0 means another starter won the singleton lock; keep waiting for its socket.
    if (child.exitCode !== null && child.exitCode !== 0) throw new GoError('BROWSER_UNAVAILABLE', `CDP relay exited; see ${RELAY_LOG}.`);
  }
  throw new GoError('BROWSER_APPROVAL_TIMEOUT', 'Chrome did not approve the relay connection in time.');
}

/** CDP client over the relay socket; same shape as a direct browser connection. */
export class RelayCdp {
  private id = 0;
  private buffer = '';
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private constructor(private socket: net.Socket) {
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const msg = JSON.parse(this.buffer.slice(0, newline));
        this.buffer = this.buffer.slice(newline + 1);
        const waiter = this.pending.get(msg.id);
        if (!waiter) continue;
        this.pending.delete(msg.id);
        clearTimeout(waiter.timer);
        if (msg.error) waiter.reject(new GoError('CDP_ERROR', String(msg.error.message)));
        else waiter.resolve(msg.result);
      }
    });
    socket.on('close', () => {
      for (const w of this.pending.values()) { clearTimeout(w.timer); w.reject(new GoError('BROWSER_UNAVAILABLE', 'CDP relay connection closed.')); }
      this.pending.clear();
    });
  }
  static async connect() {
    await ensureRelay();
    const socket = net.createConnection(RELAY_SOCKET);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', () => reject(new GoError('BROWSER_UNAVAILABLE', 'Cannot reach the CDP relay.')));
    });
    return new RelayCdp(socket);
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.delete(id)) reject(new GoError('CDP_TIMEOUT', `${method} timed out.`)); }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\n');
    });
  }
  close() { this.socket.destroy(); }
}
