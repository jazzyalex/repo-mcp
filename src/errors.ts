import { createHash } from 'node:crypto';

export class SafeError extends Error {}
/** A file whose bytes are not text the server can serve (binary, or not valid UTF-8). */
export class NotTextError extends SafeError {}
/** An operator policy that cannot be loaded or enforced. */
export class PolicyError extends SafeError {}
/** A mutation failure after intent was recorded, where the change was definitely not published. */
export class NotAppliedError extends SafeError {}
export const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
