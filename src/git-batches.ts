// Git 2.50 accepts --pathspec-from-file for `add` and `restore` but not for `diff` or `ls-files`, so large
// path sets are handed to Git in bounded batches of literal paths (after `--`, with --literal-pathspecs).
export const BATCH_MAX_PATHS = 200;
export const BATCH_MAX_BYTES = 48 * 1024;

/** Split paths into consecutive batches bounded by count and by bytes (each path counts its separator). */
export function batchPaths(paths: string[], maxPaths = BATCH_MAX_PATHS, maxBytes = BATCH_MAX_BYTES) {
  const batches: string[][] = [];
  let current: string[] = [], bytes = 0;
  for (const path of paths) {
    const size = Buffer.byteLength(path) + 1;
    if (current.length && (current.length >= maxPaths || bytes + size > maxBytes)) { batches.push(current); current = []; bytes = 0; }
    current.push(path); bytes += size;
  }
  if (current.length) batches.push(current);
  return batches;
}
