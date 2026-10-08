import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';

export const BOUNDED_JSON_MAX_BYTES = 256 * 1024;

export async function readRegularFile(file: string, limit: number, label: string) {
  const before = await lstat(file).catch(() => { throw new Error(`${label} cannot be inspected safely.`); });
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`${label} must be a regular non-symlink file.`);
  if (before.size > limit) throw new Error(`${label} exceeds ${limit} bytes.`);
  if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number') {
    throw new Error(`${label} cannot be opened safely on this platform.`);
  }
  let handle: FileHandle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw new Error(`${label} could not be opened safely.`); }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size ||
        opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs) {
      throw new Error(`${label} changed while it was being opened.`);
    }
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > limit) throw new Error(`${label} exceeded ${limit} bytes while being read.`);
    const after = await handle.stat();
    if (!after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error(`${label} changed while it was being read.`);
    }
    const pathname = await lstat(file).catch(() => { throw new Error(`${label} cannot be inspected safely after being read.`); });
    if (pathname.isSymbolicLink() || !pathname.isFile()) throw new Error(`${label} must be a regular non-symlink file.`);
    if (pathname.dev !== after.dev || pathname.ino !== after.ino || pathname.size !== after.size ||
        pathname.mtimeMs !== after.mtimeMs || pathname.ctimeMs !== after.ctimeMs) {
      throw new Error(`${label} changed while it was being read.`);
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset)); }
    catch { throw new Error(`${label} must contain valid UTF-8 text.`); }
  } finally { await handle.close(); }
}
