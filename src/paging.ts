import { SafeError } from './errors.js';

// Response pages are measured in JSON-escaped UTF-8 bytes, because that is what a
// tool response actually carries. Pages end on line boundaries; a single line that
// cannot fit is split between code points, never inside a surrogate pair.

const escapedCost = (cp: number) =>
  cp === 0x22 || cp === 0x5c || cp === 0x08 || cp === 0x0c || cp === 0x0a || cp === 0x0d || cp === 0x09 ? 2
    : cp < 0x20 ? 6
      : cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;

/** Escaped size of text[start, end), or Infinity once it exceeds `limit`. */
function costUpTo(text: string, start: number, end: number, limit: number) {
  let used = 0;
  for (let i = start; i < end;) {
    const cp = text.codePointAt(i)!;
    used += escapedCost(cp);
    if (used > limit) return Infinity;
    i += cp > 0xffff ? 2 : 1;
  }
  return used;
}

/** Largest end index after `start` whose escaped slice fits `budget`; at least one code point. */
function fitCodePoints(text: string, start: number, end: number, budget: number) {
  let used = 0, i = start;
  while (i < end) {
    const cp = text.codePointAt(i)!;
    const width = cp > 0xffff ? 2 : 1;
    used += escapedCost(cp);
    if (used > budget && i > start) break;
    i += width;
  }
  return i;
}

export function pageText(text: string, offset: number, budget: number, maxLines = Infinity) {
  let pos = offset, used = 0, lines = 0;
  while (pos < text.length && lines < maxLines) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl + 1;
    const cost = costUpTo(text, pos, end, budget - used);
    if (cost !== Infinity) { used += cost; pos = end; lines++; continue; }
    if (pos === offset) pos = fitCodePoints(text, pos, end, budget);
    break;
  }
  return { content: text.slice(offset, pos), next: pos < text.length ? pos : null };
}

export const countNewlines = (text: string, start = 0, end = text.length) => {
  let n = 0;
  for (let i = text.indexOf('\n', start); i !== -1 && i < end; i = text.indexOf('\n', i + 1)) n++;
  return n;
};

export const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

export function encodeCursor(data: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(data)).toString('base64url');
}

export function decodeCursor<T extends Record<string, unknown>>(cursor: string, kind: string): T {
  let data: unknown;
  try { data = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { data = undefined; }
  if (!data || typeof data !== 'object' || (data as { k?: unknown }).k !== kind) throw new SafeError(`Invalid cursor for ${kind}. Start again without a cursor.`);
  return data as T;
}

export const staleCursor = (what: string) => new SafeError(`Stale cursor: ${what} changed since the previous page. Start again without a cursor.`);

export function formatBytes(n: number) {
  if (n % (1024 * 1024) === 0) return `${n / (1024 * 1024)} MiB`;
  if (n % 1024 === 0) return `${n / 1024} KiB`;
  return `${n} bytes`;
}
