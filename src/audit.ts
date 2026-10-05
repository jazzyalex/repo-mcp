import { SafeError } from './repo.js';

// A failed completion log must never disguise a successfully committed edit.
export async function auditedEdit<T extends object>(
  operation: () => Promise<T>,
  record: (phase: 'started' | 'completed', result?: T) => Promise<void>
): Promise<T & { audit_warning?: string }> {
  try { await record('started'); }
  catch { throw new SafeError('Audit log unavailable. Edit was not attempted.'); }
  const result = await operation();
  try { await record('completed', result); }
  catch {
    return { ...result, audit_warning: 'Edit committed successfully, but completion audit logging failed. Do not retry the edit; inspect the returned hashes and diff.' };
  }
  return result;
}
