import { SafeError } from './errors.js';

/**
 * One monotonic deadline for a whole operation. Subprocesses get the time that is left, and the
 * operation checks it between stages and retries, so retries can never restart the budget.
 */
export class Deadline {
  private readonly end: number;
  constructor(readonly budgetMs: number, private readonly now: () => number = () => performance.now()) {
    this.end = now() + budgetMs;
  }
  remaining() { return this.end - this.now(); }
  /** Throws `error` once the budget is spent. */
  check(error: () => SafeError) { if (this.remaining() <= 0) throw error(); }
  /** Milliseconds a subprocess may still run; at least 1 so a spent budget kills it at once. */
  timeout() { return Math.max(1, Math.ceil(this.remaining())); }
}
