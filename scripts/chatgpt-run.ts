import { readRegularFile, BOUNDED_JSON_MAX_BYTES } from '../src/bounded-file.js';
import { parseArgs } from 'node:util';
import {
  CHATGPT_RUN_MAX_OUTPUT_BYTES,
  CHATGPT_RUN_MAX_PROMPT_BYTES,
  chatGptRunStatus,
  completeChatGptRun,
  failChatGptRunBeforeSubmit,
  markChatGptRunSubmitted,
  markChatGptRunUncertain,
  prepareChatGptRun,
  recoverChatGptRunLock,
  recoverChatGptRequestClaim,
  recoverChatGptRun,
  reserveChatGptRun,
  type ChatGptCoordinator,
  type ChatGptWorkKind,
  type TrustedChatGptCompletionReceipt,
  type TrustedChatGptRunReceipt
} from '../src/chatgpt-run.js';
import type { ChatSurface, ModelProfile, SanitizedModelSelectionEvidence } from '../src/model-policy.js';
import { recordTrustedBrowserObservation } from '../src/model-policy.js';
import { defaultStateDir } from '../src/task-state.js';

async function jsonFile(file: string, label: string) {
  try { return JSON.parse(await readRegularFile(file, BOUNDED_JSON_MAX_BYTES, label)) as unknown; }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} must contain valid JSON.`);
    throw error;
  }
}

function contractFromPrepared(value: unknown) {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'selection' in value) {
    return (value as { selection: unknown }).selection;
  }
  return value;
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  strict: true,
  options: {
    'state-dir': { type: 'string' }, run: { type: 'string' }, repository: { type: 'string' },
    task: { type: 'string' }, coordinator: { type: 'string' }, kind: { type: 'string' },
    profile: { type: 'string' }, surface: { type: 'string' }, 'conversation-id': { type: 'string' },
    'session-id': { type: 'string' }, 'prompt-file': { type: 'string' }, 'base-ref': { type: 'string' },
    'contract-file': { type: 'string' }, 'evidence-file': { type: 'string' },
    'output-file': { type: 'string' }, outcome: { type: 'string' }, 'failure-code': { type: 'string' },
    'prompt-sha256': { type: 'string' }, 'base-commit': { type: 'string' }, 'browser-event-id': { type: 'string' },
    'selection-id': { type: 'string' }, 'control-label': { type: 'string' },
    'model-label': { type: 'string' }, 'selected-at': { type: 'string' }, 'observed-at': { type: 'string' },
    resolution: { type: 'string' }, 'request-key': { type: 'string' },
    'submission-event-sha256': { type: 'string' }, 'output-sha256': { type: 'string' }, 'response-state': { type: 'string' }
  }
});

const command = positionals[0];
const stateDir = values['state-dir'] ?? process.env.REPO_MCP_STATE_DIR ?? defaultStateDir();
const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
const need = (name: keyof typeof values) => {
  const value = values[name];
  if (!value || typeof value !== 'string') throw new Error(`${command} requires --${name}.`);
  return value;
};
const receipt = (): TrustedChatGptRunReceipt => ({
  repositoryId: need('repository'), taskId: need('task'), promptSha256: need('prompt-sha256'),
  baseCommit: need('base-commit'), browserEventId: need('browser-event-id'), observedAt: need('observed-at'),
  conversationId: values['conversation-id'], sessionId: values['session-id']
});

try {
  if (positionals.length !== 1) throw new Error('Use: chatgpt-run prepare|status|observe|reserve|submitted|complete|uncertain|recover|recover-lock|recover-request|fail-pre-submit.');
  if (command === 'prepare') {
    const promptFile = need('prompt-file');
    print(await prepareChatGptRun({
      stateDir, repositoryId: need('repository'), taskId: need('task'),
      coordinator: need('coordinator') as ChatGptCoordinator, workKind: need('kind') as ChatGptWorkKind,
      profile: values.profile as ModelProfile | undefined, surface: need('surface') as ChatSurface,
      conversationId: values['conversation-id'], sessionId: values['session-id'], baseRef: values['base-ref'],
      prompt: await readRegularFile(promptFile, CHATGPT_RUN_MAX_PROMPT_BYTES, 'Prompt file')
    }));
  } else if (command === 'status') {
    print(await chatGptRunStatus(need('run'), stateDir));
  } else if (command === 'observe') {
    print(await recordTrustedBrowserObservation({
      selectionId: need('selection-id'), surface: need('surface') as ChatSurface,
      controlLabel: need('control-label'), modelLabel: values['model-label'],
      selectedAt: need('selected-at'), observedAt: need('observed-at'),
      conversationId: values['conversation-id'], sessionId: values['session-id']
    }, { stateDir: `${stateDir}/model-policy` }));
  } else if (command === 'reserve') {
    print(await reserveChatGptRun({
      stateDir, runId: need('run'),
      contract: contractFromPrepared(await jsonFile(need('contract-file'), 'Contract file')),
      evidence: await jsonFile(need('evidence-file'), 'Evidence file') as SanitizedModelSelectionEvidence
    }));
  } else if (command === 'submitted') {
    print(await markChatGptRunSubmitted({ runId: need('run'), stateDir, receipt: receipt() }));
  } else if (command === 'complete') {
    const outcome = need('outcome');
    if (outcome !== 'ship' && outcome !== 'no-ship' && outcome !== 'completed') throw new Error('complete --outcome must be ship, no-ship or completed.');
    if (need('response-state') !== 'completed') throw new Error('complete requires an observed completed response.');
    const completionReceipt: TrustedChatGptCompletionReceipt = { ...receipt(), kind: 'completion', responseState: 'completed',
      submissionEventSha256: need('submission-event-sha256'), outputSha256: need('output-sha256') };
    print(await completeChatGptRun({
      stateDir, runId: need('run'), outcome,
      output: await readRegularFile(need('output-file'), CHATGPT_RUN_MAX_OUTPUT_BYTES, 'Output file'), receipt: completionReceipt
    }));
  } else if (command === 'uncertain') {
    print(await markChatGptRunUncertain(need('run'), need('failure-code'), stateDir));
  } else if (command === 'recover') {
    const resolution = need('resolution');
    if (resolution !== 'submitted' && resolution !== 'not-submitted') throw new Error('recover --resolution must be submitted or not-submitted.');
    print(await recoverChatGptRun(need('run'), resolution, receipt(), stateDir));
  } else if (command === 'recover-lock') {
    print(await recoverChatGptRunLock(need('run'), stateDir));
  } else if (command === 'recover-request') {
    print(await recoverChatGptRequestClaim(need('request-key'), stateDir));
  } else if (command === 'fail-pre-submit') {
    print(await failChatGptRunBeforeSubmit(need('run'), need('failure-code'), stateDir));
  } else throw new Error('Unknown chatgpt-run command.');
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : 'ChatGPT run command failed.') + '\n');
  process.exitCode = 1;
}
