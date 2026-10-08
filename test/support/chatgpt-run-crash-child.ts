import { prepareChatGptRun, failChatGptRunBeforeSubmit } from '../../src/chatgpt-run.js';
import { StateStore } from '../../src/task-state.js';

const [mode, stateDir] = process.argv.slice(2);
if (mode !== 'initializer' && mode !== 'terminal') throw new Error('Unknown crash point.');
const originalCreate = StateStore.prototype.create;
const originalRemove = StateStore.prototype.remove;
// Deliberately die at the two durable-publication gaps; finally blocks must not run.
if (mode === 'initializer') {
  StateStore.prototype.create = async function(rel, kind, data) {
    const published = await originalCreate.call(this, rel, kind, data);
    if (published && rel.startsWith('chatgpt-run-requests/')) process.exit(91);
    return published;
  };
} else {
  StateStore.prototype.remove = async function(rel) {
    if (rel.startsWith('chatgpt-run-requests/')) process.exit(92);
    return originalRemove.call(this, rel);
  };
}
const run = await prepareChatGptRun({
  stateDir, repositoryId: 'repo', taskId: 'task', coordinator: 'codex', workKind: 'review',
  surface: 'work', conversationId: 'conversation-1', prompt: 'Crash request.',
  now: new Date('2026-10-07T20:00:00.000Z')
});
await failChatGptRunBeforeSubmit(run.run_id, 'CANCELLED', stateDir, new Date('2026-10-07T20:00:03.000Z'));
throw new Error('Expected injected crash was not reached.');
