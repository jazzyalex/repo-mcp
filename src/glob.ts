import { PolicyError } from './errors.js';

// Policy glob grammar (docs/DESIGN-2B-PATH-POLICY.md section 3). Deliberately small:
//   *   zero or more characters within one segment      ?   one character within one segment
//   **  a whole segment: zero or more directory segments (a trailing ** means "everything below")
// Anything else special ([ ] { } ! \) is rejected rather than guessed at.

export const nfc = (s: string) => s.normalize('NFC');
/** Deny comparisons fold Unicode normalisation and case. */
export const fold = (s: string) => s.normalize('NFC').toLowerCase();

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Why a path cannot be exposed at all, or undefined. Used for tool arguments and literal policy paths. */
export function pathProblem(p: string): string | undefined {
  if (!p) return 'must not be empty';
  if (Buffer.byteLength(p) > 256) return 'must be at most 256 bytes';
  if (p.startsWith('/')) return 'must be relative';
  if (p.includes('\\')) return 'must not contain a backslash';
  if (CONTROL.test(p)) return 'must not contain control characters';
  if (p.includes('�')) return 'must not contain undecodable bytes';
  if (LONE_SURROGATE.test(p)) return 'must be valid Unicode';
  for (const segment of p.split('/')) {
    if (!segment || segment === '.' || segment === '..') return 'must not contain empty, "." or ".." segments';
    if (Buffer.byteLength(segment) > 255) return 'has a segment over 255 bytes';
  }
  return undefined;
}

type Segment = { kind: 'star2' } | { kind: 'lit'; text: string } | { kind: 'glob'; re: RegExp };

export type Glob = {
  readonly source: string;
  /** No wildcard anywhere: the pattern names exactly one path. */
  readonly isLiteral: boolean;
  matches(path: string): boolean;
  /** True if some path strictly below `dir` can match (a necessary condition for descending into it). */
  couldMatchBeneath(dir: string): boolean;
  /** True if the pattern ends in `**` and its leading part matches `dir`: everything below `dir` matches. */
  coversDirectory(dir: string): boolean;
};

export function compileGlob(pattern: string, options: { fold?: boolean } = {}): Glob {
  const normalise = options.fold ? fold : nfc;
  if (!pattern) throw new PolicyError('Invalid pattern: must not be empty.');
  if (CONTROL.test(pattern) || pattern.startsWith('/')) throw new PolicyError(`Invalid pattern "${pattern}".`);
  const raw = pattern.split('/');
  if (raw.some(s => !s || s === '.' || s === '..')) throw new PolicyError(`Invalid pattern "${pattern}": empty, "." and ".." segments are not allowed.`);
  const compiled: Segment[] = raw.map(text => {
    if (text === '**') return { kind: 'star2' } as const;
    if (/\*\*|[[\]{}!\\]/.test(text)) throw new PolicyError(`Unsupported pattern syntax in "${pattern}": only *, ? and whole-segment ** are supported.`);
    const t = normalise(text);
    if (!/[*?]/.test(t)) return { kind: 'lit', text: t } as const;
    const body = [...t].map(ch => ch === '*' ? '[^/]*' : ch === '?' ? '[^/]' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('');
    return { kind: 'glob', re: new RegExp(`^${body}$`, 'su') } as const;
  });
  const trailing = compiled.at(-1)!.kind === 'star2';
  // A trailing ** matches one or more segments: normalise `a/**` to `a/**/*`.
  const segs: Segment[] = trailing ? [...compiled, { kind: 'glob', re: /^[^/]*$/su }] : compiled;
  const coverSegs = trailing ? compiled.slice(0, -1) : undefined;
  const segMatches = (segment: Segment, text: string) => segment.kind === 'lit' ? segment.text === text : segment.kind === 'glob' ? segment.re.test(text) : true;
  const run = (parts: string[], against: Segment[]) => {
    const close = (states: Set<number>) => { for (const i of [...states].sort((a, b) => a - b)) { let j = i; while (j < against.length && against[j].kind === 'star2') { j++; states.add(j); } } return states; };
    let states = close(new Set([0]));
    for (const part of parts) {
      const next = new Set<number>();
      for (const i of states) {
        if (i >= against.length) continue;
        if (against[i].kind === 'star2') next.add(i);
        else if (segMatches(against[i], part)) next.add(i + 1);
      }
      states = close(next);
      if (!states.size) break;
    }
    return states;
  };
  const split = (path: string) => normalise(path).split('/');
  return {
    source: pattern,
    isLiteral: compiled.every(s => s.kind === 'lit'),
    matches: path => run(split(path), segs).has(segs.length),
    couldMatchBeneath: dir => { const states = run(split(dir), segs); return [...states].some(i => i < segs.length); },
    coversDirectory: dir => !!coverSegs && (coverSegs.length === 0 || run(split(dir), coverSegs).has(coverSegs.length))
  };
}
