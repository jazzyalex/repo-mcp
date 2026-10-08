import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat, mkdir, readdir, lstat, readlink, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { StateStore, acquireLock, withShortLock } from '../src/task-state.js';

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'repo-mcp-state-'));

test('state reads distinguish an absent pathname from a dangling symlink and preserve it', async () => {
  const base = await tmp();
  try {
    const store = await StateStore.open(base);
    assert.equal(await store.read('missing-parent/absent.json', 'phase'), undefined);
    await mkdir(path.join(base, 'r'));
    assert.equal(await store.read('r/absent.json', 'phase'), undefined);
    const rel = 'r/dangling.json';
    const target = path.join(base, 'r', 'absent.json');
    await symlink(target, path.join(base, rel));
    const before = await lstat(path.join(base, rel));
    await assert.rejects(store.read(rel, 'phase'), /unsafe task state pathname r\/dangling\.json/i);
    const after = await lstat(path.join(base, rel));
    assert.equal(after.isSymbolicLink(), true);
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
    assert.equal(await readlink(path.join(base, rel)), target);
    assert.equal(await store.read('r/absent.json', 'phase'), undefined);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('records are versioned, owner-only and atomically replaced', async () => {
  const base = await tmp();
  try {
    const store = await StateStore.open(path.join(base, 'state'));
    await store.write('tasks/t1/phase.json', 'phase', { phase: 'coding' });
    await store.write('tasks/t1/phase.json', 'phase', { phase: 'review' });
    assert.deepEqual(await store.read('tasks/t1/phase.json', 'phase'), { phase: 'review' });
    assert.equal(await store.read('tasks/t1/missing.json', 'phase'), undefined);
    assert.equal((await stat(path.join(base, 'state', 'tasks/t1/phase.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(base, 'state'))).mode & 0o777, 0o700);
    assert.deepEqual((await readdir(path.join(base, 'state', 'tasks/t1'))).sort(), ['phase.json'], 'no temp files left behind');
    assert.equal(await store.create('tasks/t1/phase.json', 'phase', { phase: 'coding' }), false, 'create never overwrites');
    assert.equal(await store.create('tasks/t1/other.json', 'phase', { phase: 'coding' }), true);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('corrupt, unknown-version and wrong-kind records fail closed', async () => {
  const base = await tmp();
  try {
    const store = await StateStore.open(base);
    await mkdir(path.join(base, 'r'), { recursive: true });
    await writeFile(path.join(base, 'r/corrupt.json'), '{not json');
    await assert.rejects(store.read('r/corrupt.json', 'phase'), /corrupt/i);
    const malformed = JSON.stringify({ version: 1, kind: 'phase' });
    await writeFile(path.join(base, 'r/missing-data.json'), malformed);
    await assert.rejects(store.read('r/missing-data.json', 'phase'), /corrupt/i);
    assert.equal(await readFile(path.join(base, 'r/missing-data.json'), 'utf8'), malformed);
    assert.equal(await store.read('r/absent.json', 'phase'), undefined);
    await store.write('r/null-data.json', 'phase', null);
    assert.equal(await store.read('r/null-data.json', 'phase'), null);
    await writeFile(path.join(base, 'r/future.json'), JSON.stringify({ version: 99, kind: 'phase', data: {} }));
    await assert.rejects(store.read('r/future.json', 'phase'), /version/i);
    await store.write('r/kind.json', 'binding', {});
    await assert.rejects(store.read('r/kind.json', 'phase'), /kind/i);
    await assert.rejects(store.write('../escape.json', 'phase', {}), /state path/i);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('state directory must stay outside served roots', async () => {
  const base = await tmp();
  try {
    const repo = path.join(base, 'repo');
    await mkdir(repo);
    await assert.rejects(StateStore.open(path.join(repo, '.state'), { forbiddenRoots: [repo] }), /outside/);
    await assert.rejects(StateStore.open(repo, { forbiddenRoots: [repo] }), /outside/);
    await assert.rejects(StateStore.open(base, { forbiddenRoots: [repo] }), /outside/, 'a state dir containing the repo is also rejected');
    await StateStore.open(path.join(base, 'state'), { forbiddenRoots: [repo] });
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('checkout lock admits one owner and releases only its own token', async () => {
  const base = await tmp();
  try {
    const store = await StateStore.open(base);
    const lock = await acquireLock(store, 'checkout-a', 'writer');
    await assert.rejects(acquireLock(store, 'checkout-a', 'writer'), /already owned by live process/);
    const other = await acquireLock(store, 'checkout-b', 'writer');
    assert.equal(await lock.owned(), true);
    await lock.release();
    assert.equal(await lock.owned(), false);
    const again = await acquireLock(store, 'checkout-a', 'writer');
    await lock.release(); // stale handle must not delete the new owner's lock
    assert.equal(await again.owned(), true);
    await again.release(); await other.release();
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('lock acquisition retries when the previous holder disappears before inspection', async () => {
  const base = await tmp();
  try {
    const store = await StateStore.open(base);
    const create = store.create.bind(store);
    const read = store.read.bind(store);
    let lostCreate = true;
    let disappeared = true;
    store.create = async (rel: string, kind: string, data: unknown) => {
      if (rel === 'locks/handoff.json' && lostCreate) { lostCreate = false; return false; }
      return create(rel, kind, data);
    };
    store.read = async <T = unknown>(rel: string, kind: string) => {
      if (rel === 'locks/handoff.json' && disappeared) { disappeared = false; return undefined; }
      return read<T>(rel, kind);
    };
    const lock = await acquireLock(store, 'handoff', 'writer');
    assert.equal(await lock.owned(), true);
    await lock.release();
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('lock held by another process blocks, then reports stale after crash until explicitly recovered', async () => {
  const base = await tmp();
  try {
    const script = `import {StateStore, acquireLock} from ${JSON.stringify(path.resolve('src/task-state.ts'))};
const store = await StateStore.open(${JSON.stringify(base)});
await acquireLock(store, 'checkout-a', 'writer');
process.stdout.write('LOCKED\\n');
setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (b: Buffer) => { if (b.toString().includes('LOCKED')) resolve(); });
      child.on('exit', code => reject(new Error(`child exited ${code}`)));
    });
    const store = await StateStore.open(base);
    await assert.rejects(acquireLock(store, 'checkout-a', 'writer'), /already owned by live process/);
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
    await assert.rejects(acquireLock(store, 'checkout-a', 'writer'), /stale lock/i);
    const recovered = await acquireLock(store, 'checkout-a', 'writer', { recoverStale: true });
    assert.equal(await recovered.owned(), true);
    await recovered.release();
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('corrupt lock record fails closed even with stale recovery', async () => {
  const base = await tmp();
  try {
    const store = await StateStore.open(base);
    await mkdir(path.join(base, 'locks'), { recursive: true });
    await writeFile(path.join(base, 'locks', 'checkout-a.json'), 'garbage');
    await assert.rejects(acquireLock(store, 'checkout-a', 'writer', { recoverStale: true }), /corrupt/i);
    assert.equal(await readFile(path.join(base, 'locks', 'checkout-a.json'), 'utf8'), 'garbage');
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('short common-directory lock serializes cooperating operations and times out clearly', async () => {
  const base = await tmp();
  try {
    const store = await StateStore.open(base);
    const events: string[] = [];
    const op = (name: string, ms: number) => withShortLock(store, 'common-x', async () => {
      events.push(`${name}:start`); await new Promise(r => setTimeout(r, ms)); events.push(`${name}:end`);
    }, { waitMs: 2000 });
    await Promise.all([op('a', 80), op('b', 10)]);
    // Either order is fine; the operations must never overlap.
    assert.ok(['a:start,a:end,b:start,b:end', 'b:start,b:end,a:start,a:end'].includes(events.join(',')), events.join(','));
    const held = await acquireLock(store, 'common-x', 'git');
    await assert.rejects(withShortLock(store, 'common-x', async () => {}, { waitMs: 100 }), /busy/i);
    await held.release();
    await assert.rejects(withShortLock(store, 'common-x', async () => { throw new Error('inner'); }), /inner/);
    assert.equal(await (await acquireLock(store, 'common-x', 'git')).owned(), true, 'lock released after failure');
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('concurrent stale-lock recovery never removes a newly acquired lock', async () => {
  const base = await tmp();
  try {
    const store = await StateStore.open(base);
    await store.write('locks/race.json', 'lock', { pid: 2147483647, hostname: os.hostname(), token: 'stale', purpose: 'test', acquired_at: '2026-10-02T00:00:00.000Z' });
    const original = store.remove.bind(store);
    let reached!: () => void, resume!: () => void;
    const atPause = new Promise<void>(r => { reached = r; });
    const go = new Promise<void>(r => { resume = r; });
    let first = true;
    store.remove = async (rel: string) => { if (first) { first = false; reached(); await go; } return original(rel); };
    const a = acquireLock(store, 'race', 'A', { recoverStale: true });
    await atPause;
    const b = acquireLock(store, 'race', 'B', { recoverStale: true });
    const bResult = await b.then(lock => ({ lock }), error => ({ error: error as Error }));
    resume();
    const aResult = await a.then(lock => ({ lock }), error => ({ error: error as Error }));
    const winners = [aResult, bResult].filter(r => 'lock' in r) as { lock: Awaited<typeof a> }[];
    assert.equal(winners.length, 1, 'exactly one recovery may succeed');
    assert.equal(await winners[0].lock.owned(), true);
    await winners[0].lock.release();
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('lock records use one strict validator for acquisition, ownership and stale recovery', async () => {
  const base = await tmp();
  try {
    const store = await StateStore.open(base);
    const valid = {
      pid: 2147483647,
      hostname: os.hostname(),
      token: 'strict-token',
      purpose: 'writer',
      acquired_at: '2026-10-02T00:00:00.000Z'
    };
    const invalid = [
      { ...valid, pid: 0 },
      { ...valid, pid: -1 },
      { ...valid, pid: 1.5 },
      { ...valid, pid: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, hostname: '' },
      { ...valid, token: '' },
      { ...valid, purpose: '' },
      { ...valid, acquired_at: 'not-a-timestamp' }
    ];
    for (const [index, record] of invalid.entries()) {
      const key = `strict-${index}`;
      await store.write(`locks/${key}.json`, 'lock', record);
      await assert.rejects(
        acquireLock(store, key, 'writer', { recoverStale: true }),
        /corrupt lock record|manual inspection/i,
        `invalid lock case ${index}`
      );
      assert.deepEqual(await store.read(`locks/${key}.json`, 'lock'), record);
    }

    const owned = await acquireLock(store, 'owned-strict', 'writer');
    await store.write('locks/owned-strict.json', 'lock', {
      pid: process.pid,
      hostname: os.hostname(),
      purpose: 'writer',
      acquired_at: '2026-10-02T00:00:00.000Z'
    });
    await assert.rejects(owned.owned(), /corrupt lock record|manual inspection/i);
    await assert.rejects(owned.release(), /corrupt lock record|manual inspection/i);
  } finally { await rm(base, { recursive: true, force: true }); }
});
