import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, lstat, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { readRegularFile, BOUNDED_JSON_MAX_BYTES } from '../src/bounded-file.js';
import { readOraclePromptFile } from '../src/model-policy.js';
import { PROJECT_BASE } from '../src/version.js';

test('model-policy verify rejects unsafe contract and evidence files promptly', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'model-policy-json-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const valid = path.join(base, 'valid.json');
  const linked = path.join(base, 'linked.json');
  const fifo = path.join(base, 'fifo.json');
  const oversized = path.join(base, 'oversized.json');
  const invalid = path.join(base, 'invalid.json');
  await writeFile(valid, '{}');
  await symlink(valid, linked);
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  await writeFile(oversized, ' '.repeat(BOUNDED_JSON_MAX_BYTES + 1));
  // This is valid JSON after lossy decoding, so only fatal UTF-8 rejects it.
  await writeFile(invalid, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
  for (const field of ['contract', 'evidence']) {
    for (const [file, reason] of [[linked, /regular non-symlink/i], [fifo, /regular non-symlink/i],
      [oversized, /exceeds/i], [invalid, /valid UTF-8/i]] as const) {
      const result = spawnSync(process.execPath, ['--import', 'tsx', path.join(PROJECT_BASE, 'scripts/model-policy.ts'),
        'verify', '--contract-file', field === 'contract' ? file : valid,
        '--evidence-file', field === 'evidence' ? file : valid], {
        cwd: PROJECT_BASE, encoding: 'utf8', timeout: 5000,
        env: { ...process.env, NODE_OPTIONS: '' }
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1, result.stderr);
      const failure = JSON.parse(result.stdout);
      assert.equal(failure.error.code, 'JSON_FILE_UNSAFE');
      assert.match(failure.error.message, reason);
    }
  }
});

test('bounded regular-file reader rejects growth and closes the opened descriptor', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'bounded-growth-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const file = path.join(base, 'growing.json');
  await writeFile(file, '{}');
  const probe = await open(file, 'r');
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  const originalRead = prototype.read;
  await probe.close();
  let grown = false;
  const observed: { handle?: FileHandle } = {};
  t.mock.method(prototype, 'read', async function(this: FileHandle, ...args: unknown[]) {
    observed.handle = this;
    if (!grown) { grown = true; await appendFile(file, ' '.repeat(BOUNDED_JSON_MAX_BYTES + 1)); }
    return Reflect.apply(originalRead, this, args);
  });
  await assert.rejects(readRegularFile(file, BOUNDED_JSON_MAX_BYTES, 'JSON file'), /exceeded|changed/i);
  assert.equal(observed.handle?.fd, -1);
});

test('bounded regular-file reader rejects parent-directory replacement while its descriptor remains readable', async t => {
  for (const replacement of ['regular', 'symlink', 'fifo', 'directory', 'missing'] as const) {
    await t.test(replacement, async st => {
      const base = await mkdtemp(path.join(os.tmpdir(), 'bounded-path-replacement-'));
      st.after(() => rm(base, { recursive: true, force: true }));
      const parent = path.join(base, 'current');
      const moved = path.join(base, 'original');
      await mkdir(parent);
      const file = path.join(parent, 'input.json');
      const originalFile = path.join(moved, 'input.json');
      const content = '{"original":true}';
      await writeFile(file, content);
      const probe = await open(file, 'r');
      const before = await probe.stat();
      const prototype = Object.getPrototypeOf(probe) as FileHandle;
      const originalRead = prototype.read;
      await probe.close();
      let replaced = false;
      const observed: { handle?: FileHandle; bytesRead?: number } = {};
      const mocked = st.mock.method(prototype, 'read', async function(this: FileHandle, ...args: unknown[]) {
        observed.handle = this;
        if (!replaced) {
          replaced = true;
          await rename(parent, moved);
          await mkdir(parent);
          if (replacement === 'regular') await writeFile(file, content);
          else if (replacement === 'symlink') await symlink(originalFile, file);
          else if (replacement === 'fifo') assert.equal(spawnSync('mkfifo', [file]).status, 0);
          else if (replacement === 'directory') await mkdir(file);
          // Renaming the directory leaves the opened file's identity and metadata unchanged.
          const stillOpened = await this.stat();
          for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const) {
            assert.equal(stillOpened[key], before[key], key);
          }
          if (replacement === 'regular') assert.notEqual((await lstat(file)).ino, stillOpened.ino);
        }
        const result = await Reflect.apply(originalRead, this, args);
        if (result.bytesRead > 0) observed.bytesRead = result.bytesRead;
        return result;
      });
      try {
        await assert.rejects(readRegularFile(file, BOUNDED_JSON_MAX_BYTES, 'JSON file'), /changed|regular non-symlink|inspected safely/i);
        assert.equal(replaced, true);
        assert.equal(observed.bytesRead, Buffer.byteLength(content));
        assert.equal(observed.handle?.fd, -1, 'descriptor closes after rejection');
        assert.equal(await readFile(originalFile, 'utf8'), content);
      } finally { mocked.mock.restore(); }
    });
  }
});

test('bounded JSON reader rejects small growth and invalid UTF-8; Oracle prompt protections remain', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'bounded-metadata-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const file = path.join(base, 'growing.json');
  await writeFile(file, '{}');
  const probe = await open(file, 'r');
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  const originalRead = prototype.read;
  await probe.close();
  let grown = false;
  const mocked = t.mock.method(prototype, 'read', async function(this: FileHandle, ...args: unknown[]) {
    if (!grown) { grown = true; await appendFile(file, ' '); }
    return Reflect.apply(originalRead, this, args);
  });
  await assert.rejects(readRegularFile(file, BOUNDED_JSON_MAX_BYTES, 'JSON file'), /changed/i);
  mocked.mock.restore();
  const invalid = path.join(base, 'invalid.txt');
  await writeFile(invalid, Buffer.from([0xff]));
  await assert.rejects(readRegularFile(invalid, BOUNDED_JSON_MAX_BYTES, 'JSON file'), /valid UTF-8/i);
  await assert.rejects(readOraclePromptFile(invalid), /valid UTF-8/i);
  const linked = path.join(base, 'linked.txt');
  await symlink(file, linked);
  await assert.rejects(readOraclePromptFile(linked), /regular non-symlink/i);
});
