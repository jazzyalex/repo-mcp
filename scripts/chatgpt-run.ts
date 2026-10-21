import { readRegularFile, BOUNDED_JSON_MAX_BYTES } from '../src/bounded-file.js';
import { parseArgs } from 'node:util';
import {
  CHATGPT_RUN_MAX_OUTPUT_BYTES,
  CHATGPT_RUN_MAX_PROMPT_BYTES,
  chatGptRunStatus,
  completeChatGptRun,
  chatGptRunOutput,
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
import { GoError, goStatus, releaseGoAdmission, runGo } from '../src/chatgpt-go.js';
import { CdpChatGptPage } from '../src/chatgpt-browser.js';
import { ensureRelay, runRelay } from '../src/cdp-relay.js';

const HELP = `Repo MCP ChatGPT run journal

Usage:
  chatgpt-run --help
  chatgpt-run prepare [--state-dir PATH] --repository ID --task ID
    --coordinator codex|claude --kind code|review|architecture [--profile PROFILE]
    [--surface chat|work] [--surface-override-reason REASON]
    (--session-id ID|--conversation-id ID) --prompt-file FILE [--base-ref REF]
  chatgpt-run status [--state-dir PATH] --run RUN_ID
  chatgpt-run output [--state-dir PATH] --run RUN_ID
  chatgpt-run observe [--state-dir PATH] --selection-id ID --surface chat|work
    --control-label LABEL [--model-label LABEL] --selected-at ISO --observed-at ISO
    (--session-id ID|--conversation-id ID)
  chatgpt-run reserve [--state-dir PATH] --run RUN_ID
    --contract-file FILE --evidence-file FILE
  chatgpt-run submitted [--state-dir PATH] --run RUN_ID RECEIPT_FLAGS
  chatgpt-run complete [--state-dir PATH] --run RUN_ID --output-file FILE
    --outcome ship|no-ship|completed --response-state completed
    --submission-event-sha256 SHA256 --output-sha256 SHA256 RECEIPT_FLAGS
  chatgpt-run uncertain [--state-dir PATH] --run RUN_ID --failure-code CODE
  chatgpt-run recover [--state-dir PATH] --run RUN_ID
    --resolution submitted|not-submitted RECEIPT_FLAGS
  chatgpt-run recover-lock [--state-dir PATH] --run RUN_ID
  chatgpt-run recover-request [--state-dir PATH] --request-key SHA256
  chatgpt-run fail-pre-submit [--state-dir PATH] --run RUN_ID --failure-code CODE
  chatgpt-run go [--state-dir PATH] --request-id ID --repository ID --task ID
    --coordinator codex|claude --kind architecture [--profile PROFILE] --prompt-file FILE
    [--timeout-minutes N] [--max-per-hour N]
  chatgpt-run go [--state-dir PATH] --request-id ID --resume [--prompt-file FILE]
  chatgpt-run go [--state-dir PATH] --request-id ID --status
  chatgpt-run go [--state-dir PATH] --request-id ID --release-admission --reason TEXT
  chatgpt-run relay   start the CDP relay to your main Chrome (approve once per Chrome start)
  chatgpt-run probe   read-only check of ChatGPT controls; never sends

Profiles:
  code | code-hard | review | review-critical | architecture | architecture-current-pro (compatibility alias) | architecture-xhigh (Extra High)
  (profile must match the selected work kind; omitted profile uses that kind's default)

RECEIPT_FLAGS:
  --repository ID --task ID --prompt-sha256 SHA256 --base-commit COMMIT
  [--head-commit COMMIT --candidate-digest SHA256]
  --browser-event-id ID --observed-at ISO (--session-id ID|--conversation-id ID)
`;

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
    profile: { type: 'string' }, surface: { type: 'string' }, 'surface-override-reason': { type: 'string' },
    help: { type: 'boolean' }, 'conversation-id': { type: 'string' },
    'session-id': { type: 'string' }, 'prompt-file': { type: 'string' }, 'base-ref': { type: 'string' },
    'contract-file': { type: 'string' }, 'evidence-file': { type: 'string' },
    'output-file': { type: 'string' }, outcome: { type: 'string' }, 'failure-code': { type: 'string' },
    'prompt-sha256': { type: 'string' }, 'base-commit': { type: 'string' }, 'head-commit': { type: 'string' },
    'candidate-digest': { type: 'string' }, 'browser-event-id': { type: 'string' },
    'selection-id': { type: 'string' }, 'control-label': { type: 'string' },
    'model-label': { type: 'string' }, 'selected-at': { type: 'string' }, 'observed-at': { type: 'string' },
    resolution: { type: 'string' }, 'request-key': { type: 'string' },
    'submission-event-sha256': { type: 'string' }, 'output-sha256': { type: 'string' }, 'response-state': { type: 'string' },
    'request-id': { type: 'string' }, 'timeout-minutes': { type: 'string' }, 'max-per-hour': { type: 'string' },
    resume: { type: 'boolean' }, status: { type: 'boolean' },
    'release-admission': { type: 'boolean' }, reason: { type: 'string' }
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
const receiptOptions = [
  'state-dir', 'run', 'repository', 'task', 'prompt-sha256', 'base-commit',
  'head-commit', 'candidate-digest', 'browser-event-id', 'observed-at', 'conversation-id', 'session-id'
] as const;
const assertOnly = (...allowed: string[]) => {
  const allow = new Set(allowed);
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && !allow.has(name)) {
      throw new Error(`--${name} is not valid for chatgpt-run ${command ?? ''}.`);
    }
  }
};
const validateCommandOptions = () => {
  if (command === 'prepare') {
    return assertOnly(
      'state-dir', 'repository', 'task', 'coordinator', 'kind', 'profile', 'surface',
      'surface-override-reason', 'conversation-id', 'session-id', 'prompt-file', 'base-ref'
    );
  }
  if (command === 'status' || command === 'output') return assertOnly('state-dir', 'run');
  if (command === 'observe') {
    return assertOnly(
      'state-dir', 'selection-id', 'surface', 'control-label', 'model-label',
      'selected-at', 'observed-at', 'conversation-id', 'session-id'
    );
  }
  if (command === 'reserve') return assertOnly('state-dir', 'run', 'contract-file', 'evidence-file');
  if (command === 'submitted') return assertOnly(...receiptOptions);
  if (command === 'complete') {
    return assertOnly(
      ...receiptOptions, 'output-file', 'outcome', 'response-state',
      'submission-event-sha256', 'output-sha256'
    );
  }
  if (command === 'uncertain') return assertOnly('state-dir', 'run', 'failure-code');
  if (command === 'recover') return assertOnly(...receiptOptions, 'resolution');
  if (command === 'recover-lock') return assertOnly('state-dir', 'run');
  if (command === 'recover-request') return assertOnly('state-dir', 'request-key');
  if (command === 'fail-pre-submit') return assertOnly('state-dir', 'run', 'failure-code');
  if (command === 'go') {
    return assertOnly('state-dir', 'request-id', 'repository', 'task', 'coordinator', 'kind', 'profile', 'prompt-file',
      'timeout-minutes', 'max-per-hour', 'resume', 'status', 'release-admission', 'reason');
  }
  if (command === 'relay' || command === 'cdp-relay') return assertOnly();
  if (command === 'probe') return assertOnly();
  throw new Error('Unknown chatgpt-run command.');
};
const receipt = (): TrustedChatGptRunReceipt => ({
  repositoryId: need('repository'), taskId: need('task'), promptSha256: need('prompt-sha256'),
  baseCommit: need('base-commit'),
  ...(values['head-commit'] !== undefined ? { headCommit: values['head-commit'] } : {}),
  ...(values['candidate-digest'] !== undefined ? { candidateDigest: values['candidate-digest'] } : {}),
  browserEventId: need('browser-event-id'), observedAt: need('observed-at'),
  conversationId: values['conversation-id'], sessionId: values['session-id']
});

try {
  if (values.help) {
    if (positionals.length !== 0 || Object.entries(values).some(([name, value]) => name !== 'help' && value !== undefined)) {
      throw new Error('Use chatgpt-run --help without a command or other options.');
    }
    process.stdout.write(HELP);
  } else {
    if (positionals.length !== 1) throw new Error('Use: chatgpt-run prepare|status|output|observe|reserve|submitted|complete|uncertain|recover|recover-lock|recover-request|fail-pre-submit|go|relay|probe.');
    validateCommandOptions();
    if (command === 'prepare') {
      const promptFile = need('prompt-file');
      print(await prepareChatGptRun({
        stateDir, repositoryId: need('repository'), taskId: need('task'),
        coordinator: need('coordinator') as ChatGptCoordinator, workKind: need('kind') as ChatGptWorkKind,
        profile: values.profile as ModelProfile | undefined, surface: values.surface as ChatSurface | undefined,
        surfaceOverrideReason: values['surface-override-reason'],
        conversationId: values['conversation-id'], sessionId: values['session-id'], baseRef: values['base-ref'],
        prompt: await readRegularFile(promptFile, CHATGPT_RUN_MAX_PROMPT_BYTES, 'Prompt file')
      }));
    } else if (command === 'status') {
      print(await chatGptRunStatus(need('run'), stateDir));
    } else if (command === 'output') {
      // The answer is untrusted model text; never let terminal escape sequences in it reach a TTY.
      if (process.stdout.isTTY) throw new Error('chatgpt-run output prints raw model text; redirect it to a file.');
      process.stdout.write(await chatGptRunOutput(need('run'), stateDir));
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
    } else if (command === 'go') {
      const requestId = need('request-id');
      const int = (name: 'timeout-minutes' | 'max-per-hour') => {
        const v = values[name]; if (v === undefined) return undefined;
        if (!/^[1-9]\d{0,3}$/.test(v)) throw new Error(`--${name} must be a positive integer.`);
        return Number(v);
      };
      let result: unknown;
      if (values.status) result = await goStatus(stateDir, requestId);
      else if (values['release-admission']) result = await releaseGoAdmission(stateDir, requestId, values.reason ?? '');
      else {
        const promptFile = values['prompt-file'];
        const prompt = promptFile ? await readRegularFile(promptFile, CHATGPT_RUN_MAX_PROMPT_BYTES, 'Prompt file') : undefined;
        if (!values.resume && prompt === undefined) throw new Error('go requires --prompt-file (or --resume).');
        result = await runGo({
          stateDir, requestId, prompt, promptFile,
          repositoryId: values.repository, taskId: values.task, coordinator: values.coordinator as ChatGptCoordinator | undefined,
          kind: values.kind, profile: values.profile as ModelProfile | undefined,
          timeoutMinutes: int('timeout-minutes'), maxPerHour: int('max-per-hour')
        }, { page: new CdpChatGptPage() });
        const phase = (result as { phase: string }).phase;
        process.exitCode = phase === 'cleaned' ? 0 : phase === 'uncertain' ? 3 : 1;
      }
      process.stdout.write(JSON.stringify(result) + '\n');
    } else if (command === 'cdp-relay') {
      await runRelay();
    } else if (command === 'relay') {
      await ensureRelay();
      print({ relay: 'running' });
    } else if (command === 'probe') {
      print(await new CdpChatGptPage().probe());
    } else if (command === 'fail-pre-submit') {
      print(await failChatGptRunBeforeSubmit(need('run'), need('failure-code'), stateDir));
    } else {
      throw new Error('Unknown chatgpt-run command.');
    }
  }
} catch (error) {
  if (error instanceof GoError) process.stdout.write(JSON.stringify({ error: error.code, message: error.message }) + '\n');
  process.stderr.write((error instanceof Error ? error.message : 'ChatGPT run command failed.') + '\n');
  process.exitCode = 1;
}
