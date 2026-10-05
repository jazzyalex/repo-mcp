import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual, TextDecoder } from 'node:util';
import { resolveIdentity } from './identity.js';
import { StateStore, defaultStateDir } from './task-state.js';

export const MODEL_POLICY_SCHEMA_VERSION = 2 as const;
export const MODEL_POLICY_TTL_MS = 120_000;
export const MODEL_POLICY_MAX_OBSERVATION_AGE_MS = 10_000;

export type ModelProfile =
  | 'code'
  | 'code-hard'
  | 'review'
  | 'review-critical'
  | 'brainstorm'
  | 'plan'
  | 'architecture';

export type ChatSurface = 'chat' | 'work';
type CanonicalModel = 'sol' | 'sol-pro';
type CanonicalTarget = 'high' | 'xhigh' | 'pro';
type ObservedTarget = CanonicalTarget | 'light';
type CanonicalModelFamily = 'Sol' | 'Sol Pro';
type CanonicalTargetLabel = 'High' | 'Extra High' | 'Pro';
type ObservedTargetLabel = CanonicalTargetLabel | 'Light';

type ProfileTarget = {
  model: CanonicalModel;
  target: CanonicalTarget;
  picker: 'High' | 'XHigh' | 'Pro';
  modelLabel: CanonicalModelFamily;
  targetLabel: CanonicalTargetLabel;
};

const PROFILE_TARGETS: Record<ModelProfile, ProfileTarget> = {
  code: { model: 'sol', target: 'high', picker: 'High', modelLabel: 'Sol', targetLabel: 'High' },
  'code-hard': { model: 'sol', target: 'xhigh', picker: 'XHigh', modelLabel: 'Sol', targetLabel: 'Extra High' },
  review: { model: 'sol', target: 'xhigh', picker: 'XHigh', modelLabel: 'Sol', targetLabel: 'Extra High' },
  'review-critical': { model: 'sol-pro', target: 'pro', picker: 'Pro', modelLabel: 'Sol Pro', targetLabel: 'Pro' },
  brainstorm: { model: 'sol-pro', target: 'pro', picker: 'Pro', modelLabel: 'Sol Pro', targetLabel: 'Pro' },
  plan: { model: 'sol-pro', target: 'pro', picker: 'Pro', modelLabel: 'Sol Pro', targetLabel: 'Pro' },
  architecture: { model: 'sol-pro', target: 'pro', picker: 'Pro', modelLabel: 'Sol Pro', targetLabel: 'Pro' }
};

const PROFILE_NAMES = new Set<string>(Object.keys(PROFILE_TARGETS));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const REQUEST_KIND = 'model-policy-request-v2';
const OBSERVATION_KIND = 'model-policy-observation-v2';
const CONSUMED_KIND = 'model-policy-consumed-v2';

const SOL_MODEL_LABELS = new Map<string, string>([
  ['sol', 'Sol'],
  ['gpt-5.6 sol', 'GPT-5.6 Sol'],
  ['gpt-6.1 sol', 'GPT-6.1 Sol']
]);
const SOL_PRO_MODEL_LABELS = new Map<string, string>([
  ['sol pro', 'Sol Pro'],
  ['gpt-5.6 sol pro', 'GPT-5.6 Sol Pro'],
  ['gpt-6.1 sol pro', 'GPT-6.1 Sol Pro']
]);

export class ModelPolicyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ModelPolicyError';
    this.code = code;
  }
}

export type BrowserContextBinding = {
  conversation_id_sha256?: string;
  session_id_sha256?: string;
};

export type ModelSelectionContract = {
  schema_version: typeof MODEL_POLICY_SCHEMA_VERSION;
  selection_id: string;
  profile: ModelProfile;
  surface: ChatSurface;
  picker_target: 'High' | 'XHigh' | 'Pro';
  expected_model_label: CanonicalModelFamily;
  expected_target_label: CanonicalTargetLabel;
  required_selection_method: 'model-picker';
  required_evidence_source: 'trusted-browser-adapter-live-control';
  requested_at: string;
  expires_at: string;
  browser_context: BrowserContextBinding;
};

export type SanitizedModelSelectionEvidence = {
  schema_version: typeof MODEL_POLICY_SCHEMA_VERSION;
  selection_id: string;
  profile: ModelProfile;
  surface: 'Chat' | 'Work';
  observed_model_family: CanonicalModelFamily | null;
  observed_model_label: string | null;
  observed_target_label: ObservedTargetLabel;
  observed_control_label: string;
  selection_method: 'model-picker';
  control_source: 'live-composer-control';
  selected_at: string;
  observed_at: string;
  browser_context: BrowserContextBinding;
};

export type TrustedBrowserObservationInput = {
  selectionId: string;
  surface: ChatSurface;
  controlLabel: string;
  modelLabel?: string;
  selectedAt: string;
  observedAt: string;
  conversationId?: string;
  sessionId?: string;
};

function fail(code: string, message: string): never {
  throw new ModelPolicyError(code, message);
}

function asObject(value: unknown, kind: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_' + kind.toUpperCase(), kind + ' must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function rawIdentity(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || CONTROL.test(value)) {
    fail('INVALID_IDENTITY', key + ' must be a nonempty control-free string of at most 512 characters.');
  }
  return value;
}

function identityHash(kind: 'conversation' | 'session', value: string) {
  return createHash('sha256').update(kind + '\0' + value, 'utf8').digest('hex');
}

function hashBrowserContext(
  conversationValue: unknown,
  sessionValue: unknown,
  options: { required?: boolean } = {}
): BrowserContextBinding {
  const conversation = rawIdentity(conversationValue, 'conversation_id');
  const session = rawIdentity(sessionValue, 'session_id');
  if (options.required !== false && conversation === undefined && session === undefined) {
    fail('BROWSER_CONTEXT_REQUIRED', 'A conversation or session identity from the trusted browser context is required.');
  }
  return {
    ...(conversation !== undefined ? { conversation_id_sha256: identityHash('conversation', conversation) } : {}),
    ...(session !== undefined ? { session_id_sha256: identityHash('session', session) } : {})
  };
}

function parseBrowserContext(value: unknown, kind: 'contract' | 'evidence'): BrowserContextBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_' + kind.toUpperCase(), 'browser_context must be a JSON object.');
  }
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (key !== 'conversation_id_sha256' && key !== 'session_id_sha256') {
      fail('INVALID_' + kind.toUpperCase(), 'browser_context contains an unsupported field.');
    }
  }
  const conversation = object.conversation_id_sha256;
  const session = object.session_id_sha256;
  if (conversation === undefined && session === undefined) {
    fail('INVALID_' + kind.toUpperCase(), 'browser_context must contain a bound conversation or session identity hash.');
  }
  if (conversation !== undefined && (typeof conversation !== 'string' || !SHA256.test(conversation))) {
    fail('INVALID_' + kind.toUpperCase(), 'conversation_id_sha256 must be a lowercase SHA-256 digest.');
  }
  if (session !== undefined && (typeof session !== 'string' || !SHA256.test(session))) {
    fail('INVALID_' + kind.toUpperCase(), 'session_id_sha256 must be a lowercase SHA-256 digest.');
  }
  return {
    ...(conversation !== undefined ? { conversation_id_sha256: conversation as string } : {}),
    ...(session !== undefined ? { session_id_sha256: session as string } : {})
  };
}

function parseProfile(value: unknown): ModelProfile {
  if (typeof value !== 'string' || !PROFILE_NAMES.has(value)) {
    fail('UNKNOWN_PROFILE', 'Unknown model profile; no fallback is permitted.');
  }
  return value as ModelProfile;
}

function parseSurfaceContract(value: unknown): ChatSurface {
  if (value !== 'chat' && value !== 'work') fail('INVALID_SURFACE', 'Surface must be exactly chat or work.');
  return value;
}

function normalizeUiLabel(value: unknown, code: string, field: string): string {
  if (typeof value !== 'string') fail(code, field + ' must be a string.');
  const normalized = value.trim().replace(/\s+/gu, ' ').toLowerCase();
  if (!normalized) fail(code, field + ' is empty.');
  if (normalized.length > 160 || CONTROL.test(normalized)) fail(code, field + ' is not a supported control label.');
  return normalized;
}

function parseAllowedModelLabel(value: unknown): {
  model: CanonicalModel;
  family: CanonicalModelFamily;
  label: string;
} {
  const normalized = normalizeUiLabel(value, 'UNSUPPORTED_MODEL_LABEL', 'model_label');
  const sol = SOL_MODEL_LABELS.get(normalized);
  if (sol) return { model: 'sol', family: 'Sol', label: sol };
  const pro = SOL_PRO_MODEL_LABELS.get(normalized);
  if (pro) return { model: 'sol-pro', family: 'Sol Pro', label: pro };
  fail('UNSUPPORTED_MODEL_LABEL', 'Observed model label is not an allowlisted Sol-family label.');
}

function parseStandaloneTarget(value: unknown): { target: ObservedTarget; label: ObservedTargetLabel } {
  const normalized = normalizeUiLabel(value, 'UNSUPPORTED_TARGET_LABEL', 'control_label');
  if (normalized === 'high') return { target: 'high', label: 'High' };
  if (normalized === 'xhigh' || normalized === 'extra high') return { target: 'xhigh', label: 'Extra High' };
  if (normalized === 'pro') return { target: 'pro', label: 'Pro' };
  fail('UNSUPPORTED_TARGET_LABEL', 'Observed Chat control label is not an allowlisted effort/target label.');
}

function parseWorkControlLabel(value: unknown): {
  model: CanonicalModel;
  family: CanonicalModelFamily;
  modelLabel: string;
  target: ObservedTarget;
  targetLabel: ObservedTargetLabel;
  controlLabel: string;
} {
  const normalized = normalizeUiLabel(value, 'UNSUPPORTED_MODEL_LABEL', 'control_label');
  const pro = SOL_PRO_MODEL_LABELS.get(normalized);
  if (pro) {
    return {
      model: 'sol-pro',
      family: 'Sol Pro',
      modelLabel: pro,
      target: 'pro',
      targetLabel: 'Pro',
      controlLabel: pro
    };
  }

  const suffixes: Array<[string, ObservedTarget, ObservedTargetLabel]> = [
    ['extra high', 'xhigh', 'Extra High'],
    ['xhigh', 'xhigh', 'Extra High'],
    ['high', 'high', 'High'],
    ['light', 'light', 'Light']
  ];
  for (const [suffix, target, targetLabel] of suffixes) {
    if (!normalized.endsWith(' ' + suffix)) continue;
    const modelKey = normalized.slice(0, -(suffix.length + 1));
    const modelLabel = SOL_MODEL_LABELS.get(modelKey);
    if (!modelLabel) {
      fail('UNSUPPORTED_MODEL_LABEL', 'Observed Work control does not expose an allowlisted Sol-family model.');
    }
    return {
      model: 'sol',
      family: 'Sol',
      modelLabel,
      target,
      targetLabel,
      controlLabel: modelLabel + ' ' + targetLabel
    };
  }

  for (const modelKey of SOL_MODEL_LABELS.keys()) {
    if (normalized.startsWith(modelKey + ' ')) {
      fail('UNSUPPORTED_TARGET_LABEL', 'Observed Work control exposes Sol with an unsupported effort/target label.');
    }
  }
  fail('UNSUPPORTED_MODEL_LABEL', 'Observed Work control does not expose an allowlisted Sol-family model.');
}

function parseInstant(value: unknown, field: string, kind: 'contract' | 'evidence'): { text: string; millis: number } {
  if (typeof value !== 'string') fail('INVALID_' + kind.toUpperCase(), field + ' must be a canonical UTC ISO timestamp.');
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    fail('INVALID_' + kind.toUpperCase(), field + ' must be a canonical UTC ISO timestamp.');
  }
  return { text: value, millis };
}

function assertSelectionId(value: unknown, kind: 'contract' | 'evidence'): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    fail('INVALID_' + kind.toUpperCase(), 'selection_id must be a UUID.');
  }
  return value;
}

function validateContract(input: unknown): ModelSelectionContract {
  const object = asObject(input, 'contract');
  if (object.schema_version !== MODEL_POLICY_SCHEMA_VERSION) {
    fail('INVALID_CONTRACT', 'Unsupported model-policy contract version.');
  }

  const profile = parseProfile(object.profile);
  const target = PROFILE_TARGETS[profile];
  const surface = parseSurfaceContract(object.surface);
  const selectionId = assertSelectionId(object.selection_id, 'contract');
  const requested = parseInstant(object.requested_at, 'requested_at', 'contract');
  const expires = parseInstant(object.expires_at, 'expires_at', 'contract');
  if (expires.millis !== requested.millis + MODEL_POLICY_TTL_MS) {
    fail('INVALID_CONTRACT', 'Contract expiry does not match the fixed model-policy TTL.');
  }
  if (
    object.picker_target !== target.picker ||
    object.expected_model_label !== target.modelLabel ||
    object.expected_target_label !== target.targetLabel ||
    object.required_selection_method !== 'model-picker' ||
    object.required_evidence_source !== 'trusted-browser-adapter-live-control'
  ) {
    fail('INVALID_CONTRACT', 'Contract target fields do not match the requested profile.');
  }

  return {
    schema_version: MODEL_POLICY_SCHEMA_VERSION,
    selection_id: selectionId,
    profile,
    surface,
    picker_target: target.picker,
    expected_model_label: target.modelLabel,
    expected_target_label: target.targetLabel,
    required_selection_method: 'model-picker',
    required_evidence_source: 'trusted-browser-adapter-live-control',
    requested_at: requested.text,
    expires_at: expires.text,
    browser_context: parseBrowserContext(object.browser_context, 'contract')
  };
}

function parseEvidenceReceipt(input: unknown) {
  const object = asObject(input, 'evidence');
  if (object.schema_version !== MODEL_POLICY_SCHEMA_VERSION) {
    fail('INVALID_EVIDENCE', 'Unsupported model-policy evidence version.');
  }

  const selectionId = assertSelectionId(object.selection_id, 'evidence');
  const profile = parseProfile(object.profile);
  const surface = object.surface === 'Chat' ? 'Chat' : object.surface === 'Work' ? 'Work' : undefined;
  if (!surface) fail('INVALID_EVIDENCE', 'Evidence surface must be exactly Chat or Work.');
  if (object.selection_method !== 'model-picker') {
    fail('INVALID_EVIDENCE', 'Trusted evidence must describe an explicit browser model-picker selection.');
  }
  if (object.control_source !== 'live-composer-control') {
    fail('INVALID_EVIDENCE', 'Trusted evidence must describe the re-read live composer control.');
  }
  const selected = parseInstant(object.selected_at, 'selected_at', 'evidence');
  const observed = parseInstant(object.observed_at, 'observed_at', 'evidence');
  const browserContext = parseBrowserContext(object.browser_context, 'evidence');

  let model: CanonicalModel | null;
  let modelFamily: CanonicalModelFamily | null;
  let modelLabel: string | null;
  let target: ObservedTarget;
  let targetLabel: ObservedTargetLabel;
  let controlLabel: string;

  if (surface === 'Work') {
    const parsed = parseWorkControlLabel(object.observed_control_label);
    model = parsed.model;
    modelFamily = parsed.family;
    modelLabel = parsed.modelLabel;
    target = parsed.target;
    targetLabel = parsed.targetLabel;
    controlLabel = parsed.controlLabel;
    if (
      object.observed_model_family !== modelFamily ||
      object.observed_model_label !== modelLabel ||
      object.observed_target_label !== targetLabel
    ) fail('INVALID_EVIDENCE', 'Work evidence fields disagree with the allowlisted live control label.');
  } else {
    const parsedTarget = parseStandaloneTarget(object.observed_control_label);
    target = parsedTarget.target;
    targetLabel = parsedTarget.label;
    controlLabel = parsedTarget.label;
    if (object.observed_model_family === null && object.observed_model_label === null) {
      model = null;
      modelFamily = null;
      modelLabel = null;
    } else {
      const parsedModel = parseAllowedModelLabel(object.observed_model_label);
      model = parsedModel.model;
      modelFamily = parsedModel.family;
      modelLabel = parsedModel.label;
      if (object.observed_model_family !== modelFamily) {
        fail('INVALID_EVIDENCE', 'Chat model-family and model-label evidence disagree.');
      }
    }
    if (object.observed_target_label !== targetLabel) {
      fail('INVALID_EVIDENCE', 'Chat target evidence disagrees with the live control label.');
    }
  }

  const receipt: SanitizedModelSelectionEvidence = {
    schema_version: MODEL_POLICY_SCHEMA_VERSION,
    selection_id: selectionId,
    profile,
    surface,
    observed_model_family: modelFamily,
    observed_model_label: modelLabel,
    observed_target_label: targetLabel,
    observed_control_label: controlLabel,
    selection_method: 'model-picker',
    control_source: 'live-composer-control',
    selected_at: selected.text,
    observed_at: observed.text,
    browser_context: browserContext
  };
  return {
    receipt,
    model,
    target,
    selectedMillis: selected.millis,
    observedMillis: observed.millis
  };
}

function modelPolicyStateDir(override?: string) {
  return override ?? path.join(defaultStateDir(), 'model-policy');
}

function privateStateFailure(error: unknown): never {
  if (error instanceof ModelPolicyError) throw error;
  fail('PRIVATE_STATE_ERROR', 'Owner-controlled model-policy state is unavailable, corrupt, or unsafe.');
}

async function openOwnerState(dir: string) {
  try {
    const existing = await StateStore.inspect(dir);
    if (existing) return existing;
    return await StateStore.open(dir);
  } catch (error) {
    privateStateFailure(error);
  }
}

async function inspectOwnerState(dir: string) {
  try {
    const store = await StateStore.inspect(dir);
    if (!store) fail('PRIVATE_STATE_MISSING', 'Owner-controlled model-policy state does not exist for this authorization.');
    return store;
  } catch (error) {
    privateStateFailure(error);
  }
}

async function stateRead<T>(store: StateStore, rel: string, kind: string) {
  try {
    return await store.read<T>(rel, kind);
  } catch (error) {
    privateStateFailure(error);
  }
}

async function stateCreate(store: StateStore, rel: string, kind: string, data: unknown) {
  try {
    return await store.create(rel, kind, data);
  } catch (error) {
    privateStateFailure(error);
  }
}

const requestPath = (selectionId: string) => 'requests/' + selectionId + '.json';
const observationPath = (selectionId: string) => 'observations/' + selectionId + '.json';
const consumedPath = (selectionId: string) => 'consumed/' + selectionId + '.json';

type ModelPolicyClock = Date | (() => Date);

function checkedNow(now: ModelPolicyClock | undefined, purpose: string) {
  const instant = typeof now === 'function' ? now() : now ?? new Date();
  const value = instant instanceof Date ? instant.getTime() : Number.NaN;
  if (!Number.isFinite(value)) fail('INVALID_TIME', 'Cannot ' + purpose + ' with an invalid clock value.');
  return value;
}

function validateObservationTimes(
  contract: ModelSelectionContract,
  selectedMillis: number,
  observedMillis: number,
  nowMillis: number
) {
  const requestedMillis = Date.parse(contract.requested_at);
  const expiresMillis = Date.parse(contract.expires_at);
  if (nowMillis < requestedMillis) fail('INVALID_TIME', 'Verification clock precedes the selection request.');
  if (nowMillis > expiresMillis) fail('STALE_CONTRACT', 'Model selection contract has expired; resolve and select again.');
  if (selectedMillis < requestedMillis || observedMillis < requestedMillis) {
    fail('EVIDENCE_BEFORE_REQUEST', 'Trusted browser observation predates the requested selection.');
  }
  if (observedMillis < selectedMillis) {
    fail('INVALID_EVIDENCE_ORDER', 'Live-control observation predates picker selection.');
  }
  if (selectedMillis > expiresMillis || observedMillis > expiresMillis) {
    fail('STALE_EVIDENCE', 'Trusted browser observation was captured after the contract expired.');
  }
  if (observedMillis > nowMillis) fail('INVALID_TIME', 'Live-control observation is dated in the future.');
  if (nowMillis - observedMillis > MODEL_POLICY_MAX_OBSERVATION_AGE_MS) {
    fail('OBSERVATION_TOO_OLD', 'Live-control observation is too old; resolve a new selection, select again, and record a new live-control observation immediately before submission.');
  }
}

export async function resolveModelProfile(
  profileInput: ModelProfile,
  surfaceInput: ChatSurface,
  options: {
    now?: Date;
    selectionId?: string;
    conversationId?: string;
    sessionId?: string;
    stateDir?: string;
  } = {}
): Promise<ModelSelectionContract> {
  const profile = parseProfile(profileInput);
  const surface = parseSurfaceContract(surfaceInput);
  const target = PROFILE_TARGETS[profile];
  const requestedMillis = checkedNow(options.now, 'resolve a model profile');
  const selectionId = options.selectionId ?? randomUUID();
  assertSelectionId(selectionId, 'contract');
  const browserContext = hashBrowserContext(options.conversationId, options.sessionId);

  const contract: ModelSelectionContract = {
    schema_version: MODEL_POLICY_SCHEMA_VERSION,
    selection_id: selectionId,
    profile,
    surface,
    picker_target: target.picker,
    expected_model_label: target.modelLabel,
    expected_target_label: target.targetLabel,
    required_selection_method: 'model-picker',
    required_evidence_source: 'trusted-browser-adapter-live-control',
    requested_at: new Date(requestedMillis).toISOString(),
    expires_at: new Date(requestedMillis + MODEL_POLICY_TTL_MS).toISOString(),
    browser_context: browserContext
  };

  const store = await openOwnerState(modelPolicyStateDir(options.stateDir));
  if (!(await stateCreate(store, requestPath(selectionId), REQUEST_KIND, contract))) {
    fail('SELECTION_ID_COLLISION', 'Selection ID already exists in owner-controlled model-policy state.');
  }
  return contract;
}

/**
 * Trust boundary for the external browser adapter.
 *
 * Call this only from adapter code that directly performed the model-picker action,
 * re-read the live composer control after UI replacement, and obtained the bound
 * conversation/session identity from the browser context. This function is
 * intentionally not exposed as an untrusted CLI command. It turns that trusted
 * in-process observation into a private owner-state record plus a sanitized receipt.
 */
export async function recordTrustedBrowserObservation(
  input: TrustedBrowserObservationInput,
  options: { now?: Date; stateDir?: string } = {}
): Promise<SanitizedModelSelectionEvidence> {
  const selectionId = assertSelectionId(input.selectionId, 'evidence');
  const store = await inspectOwnerState(modelPolicyStateDir(options.stateDir));
  const storedContractRaw = await stateRead<unknown>(store, requestPath(selectionId), REQUEST_KIND);
  if (storedContractRaw === undefined) fail('UNKNOWN_SELECTION', 'No private selection request exists for this selection ID.');
  const contract = validateContract(storedContractRaw);

  if (await stateRead<unknown>(store, consumedPath(selectionId), CONSUMED_KIND) !== undefined) {
    fail('SELECTION_ALREADY_CONSUMED', 'This model-selection authorization has already been consumed.');
  }
  const surface = parseSurfaceContract(input.surface);
  if (surface !== contract.surface) fail('SURFACE_MISMATCH', 'Trusted browser observation came from the wrong ChatGPT surface.');
  const browserContext = hashBrowserContext(input.conversationId, input.sessionId);
  if (!isDeepStrictEqual(browserContext, contract.browser_context)) {
    fail('BROWSER_CONTEXT_MISMATCH', 'Trusted browser observation does not match the bound conversation/session context.');
  }

  const selected = parseInstant(input.selectedAt, 'selected_at', 'evidence');
  const observed = parseInstant(input.observedAt, 'observed_at', 'evidence');
  validateObservationTimes(contract, selected.millis, observed.millis, checkedNow(options.now, 'record browser evidence'));

  let model: CanonicalModel | null;
  let modelFamily: CanonicalModelFamily | null;
  let modelLabel: string | null;
  let target: ObservedTarget;
  let targetLabel: ObservedTargetLabel;
  let controlLabel: string;

  if (surface === 'work') {
    if (input.modelLabel !== undefined) {
      fail('INVALID_EVIDENCE', 'Work evidence must use the combined live control label, not a caller-supplied separate model label.');
    }
    const parsed = parseWorkControlLabel(input.controlLabel);
    model = parsed.model;
    modelFamily = parsed.family;
    modelLabel = parsed.modelLabel;
    target = parsed.target;
    targetLabel = parsed.targetLabel;
    controlLabel = parsed.controlLabel;
  } else {
    const parsedTarget = parseStandaloneTarget(input.controlLabel);
    target = parsedTarget.target;
    targetLabel = parsedTarget.label;
    controlLabel = parsedTarget.label;
    if (input.modelLabel === undefined) {
      model = null;
      modelFamily = null;
      modelLabel = null;
    } else {
      const parsedModel = parseAllowedModelLabel(input.modelLabel);
      model = parsedModel.model;
      modelFamily = parsedModel.family;
      modelLabel = parsedModel.label;
    }
  }

  const receipt: SanitizedModelSelectionEvidence = {
    schema_version: MODEL_POLICY_SCHEMA_VERSION,
    selection_id: contract.selection_id,
    profile: contract.profile,
    surface: surface === 'chat' ? 'Chat' : 'Work',
    observed_model_family: modelFamily,
    observed_model_label: modelLabel,
    observed_target_label: targetLabel,
    observed_control_label: controlLabel,
    selection_method: 'model-picker',
    control_source: 'live-composer-control',
    selected_at: selected.text,
    observed_at: observed.text,
    browser_context: contract.browser_context
  };

  // Parse our own sanitized receipt before publishing private state so schema/label
  // changes cannot create an unreadable authorization record.
  const parsedReceipt = parseEvidenceReceipt(receipt);
  if (parsedReceipt.model !== model || parsedReceipt.target !== target) {
    fail('INVALID_EVIDENCE', 'Sanitized browser observation is internally inconsistent.');
  }
  if (!(await stateCreate(store, observationPath(selectionId), OBSERVATION_KIND, receipt))) {
    fail('OBSERVATION_ALREADY_RECORDED', 'A trusted browser observation already exists for this selection request.');
  }
  return receipt;
}

export async function verifyModelSelection(
  contractInput: unknown,
  evidenceInput: unknown,
  options: { now?: ModelPolicyClock; stateDir?: string } = {}
) {
  const contractMirror = validateContract(contractInput);
  const store = await inspectOwnerState(modelPolicyStateDir(options.stateDir));
  const storedContractRaw = await stateRead<unknown>(store, requestPath(contractMirror.selection_id), REQUEST_KIND);
  if (storedContractRaw === undefined) fail('UNKNOWN_SELECTION', 'No private selection request exists for this selection ID.');
  const contract = validateContract(storedContractRaw);
  if (!isDeepStrictEqual(contractMirror, contract)) {
    fail('CONTRACT_STATE_MISMATCH', 'Caller contract does not match the original owner-controlled selection request.');
  }

  if (await stateRead<unknown>(store, consumedPath(contract.selection_id), CONSUMED_KIND) !== undefined) {
    fail('SELECTION_ALREADY_CONSUMED', 'This model-selection authorization has already been consumed.');
  }

  const storedEvidenceRaw = await stateRead<unknown>(store, observationPath(contract.selection_id), OBSERVATION_KIND);
  if (storedEvidenceRaw === undefined) {
    fail('UNTRUSTED_EVIDENCE', 'No trusted browser-adapter observation exists for this selection request.');
  }
  const storedEvidence = parseEvidenceReceipt(storedEvidenceRaw);
  const evidenceMirror = parseEvidenceReceipt(evidenceInput);
  if (!isDeepStrictEqual(evidenceMirror.receipt, storedEvidence.receipt)) {
    fail('EVIDENCE_STATE_MISMATCH', 'Caller evidence does not match the private trusted-browser observation.');
  }

  if (storedEvidence.receipt.selection_id !== contract.selection_id) {
    fail('SELECTION_ID_MISMATCH', 'Trusted observation belongs to a different selection request.');
  }
  if (storedEvidence.receipt.profile !== contract.profile) {
    fail('PROFILE_MISMATCH', 'Trusted observation profile does not match the original selection request.');
  }
  const observedSurface: ChatSurface = storedEvidence.receipt.surface === 'Chat' ? 'chat' : 'work';
  if (observedSurface !== contract.surface) fail('SURFACE_MISMATCH', 'Trusted observation came from the wrong ChatGPT surface.');
  if (!isDeepStrictEqual(storedEvidence.receipt.browser_context, contract.browser_context)) {
    fail('BROWSER_CONTEXT_MISMATCH', 'Trusted observation does not match the bound browser context.');
  }

  const preConsumeMillis = checkedNow(options.now, 'verify model evidence');
  validateObservationTimes(contract, storedEvidence.selectedMillis, storedEvidence.observedMillis, preConsumeMillis);
  const target = PROFILE_TARGETS[contract.profile];
  if (storedEvidence.model === null) {
    fail('MODEL_UNPROVEN', 'The live browser evidence does not expose a model family, so the requested Sol profile cannot be proven on this surface.');
  }
  if (storedEvidence.model !== target.model) {
    fail('MODEL_MISMATCH', 'Observed model family does not satisfy the requested profile.');
  }
  if (storedEvidence.target !== target.target) {
    fail('TARGET_MISMATCH', 'Observed effort/target does not satisfy the requested profile; no downgrade or promotion is permitted.');
  }

  // This exclusive state creation is the authorization boundary: exactly one
  // verifier wins. If it succeeds and the process dies before returning, the
  // authorization stays consumed and the adapter must resolve/select again.
  if (!(await stateCreate(store, consumedPath(contract.selection_id), CONSUMED_KIND, {
    selection_id: contract.selection_id,
    preconsume_validated_at: new Date(preConsumeMillis).toISOString(),
    observed_at: storedEvidence.receipt.observed_at
  }))) {
    fail('SELECTION_ALREADY_CONSUMED', 'This model-selection authorization has already been consumed.');
  }

  // Time can advance while the exclusive create blocks. Re-check freshness after
  // consumption; if it crossed a boundary, fail closed and deliberately leave the
  // immutable consumed marker in place so the authorization cannot be replayed.
  const postConsumeMillis = checkedNow(options.now, 'verify model evidence after consumption');
  validateObservationTimes(contract, storedEvidence.selectedMillis, storedEvidence.observedMillis, postConsumeMillis);

  return {
    ok: true as const,
    verified_at: new Date(postConsumeMillis).toISOString(),
    expires_at: contract.expires_at,
    selection: {
      selection_id: contract.selection_id,
      profile: contract.profile,
      surface: contract.surface,
      picker_target: contract.picker_target,
      browser_context: contract.browser_context
    },
    evidence: storedEvidence.receipt
  };
}

export const ORACLE_CLI_PATH = '/opt/homebrew/bin/oracle' as const;
export const ORACLE_SUPPORTED_VERSION = '0.21.1' as const;
export const ORACLE_SESSION_META_MAX_BYTES = 1024 * 1024;
export const ORACLE_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
export const ORACLE_PROMPT_MAX_BYTES = 1024 * 1024;

type OracleModel = 'gpt-5.6-sol' | 'gpt-5-pro';
type OracleThinking = 'high' | 'extra-high' | 'pro';

export type OracleProfileTarget = {
  model: OracleModel;
  thinking: OracleThinking;
};

const ORACLE_PROFILE_TARGETS: Record<ModelProfile, OracleProfileTarget> = {
  code: { model: 'gpt-5.6-sol', thinking: 'high' },
  'code-hard': { model: 'gpt-5.6-sol', thinking: 'extra-high' },
  review: { model: 'gpt-5.6-sol', thinking: 'extra-high' },
  'review-critical': { model: 'gpt-5-pro', thinking: 'pro' },
  brainstorm: { model: 'gpt-5-pro', thinking: 'pro' },
  plan: { model: 'gpt-5-pro', thinking: 'pro' },
  architecture: { model: 'gpt-5-pro', thinking: 'pro' }
};

const ORACLE_SLUG = /^[a-z0-9](?:[a-z0-9-]{6,62}[a-z0-9])$/;
const ORACLE_BROWSER_TAB = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ORACLE_CAPTURE_BYTES = 32 * 1024;
const ORACLE_RUN_JOURNAL_MAX_BYTES = 64 * 1024;
const ORACLE_RUN_JOURNAL_KIND = 'oracle-run-journal-v1' as const;
const ORACLE_REQUIRED_HELP_OPTIONS = [
  '--engine',
  '--browser-cookie-sync',
  '--browser-model-strategy',
  '--browser-archive',
  '--model',
  '--browser-thinking-time',
  '--browser-tab',
  '--slug',
  '--write-output',
  '--file',
  '-p'
] as const;

export function oracleTargetForProfile(profileInput: ModelProfile): OracleProfileTarget {
  return { ...ORACLE_PROFILE_TARGETS[parseProfile(profileInput)] };
}

function safeRelative(child: string, parent: string) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateOracleSlug(value: string) {
  if (!ORACLE_SLUG.test(value)) {
    fail('INVALID_ORACLE_SLUG', 'Oracle session slug must be 8-64 lowercase ASCII letters, digits, or hyphens, with alphanumeric ends.');
  }
  return value;
}

function validateOracleBrowserTab(value: unknown) {
  if (typeof value !== 'string' || !ORACLE_BROWSER_TAB.test(value)) {
    fail('INVALID_ORACLE_BROWSER_TAB', 'Oracle browser tab must be an explicit 1-128 character alphanumeric tab reference using only . _ : or - separators.');
  }
  return value;
}

function newOracleSlug(profile: ModelProfile) {
  return validateOracleSlug(`repo-mcp-${profile}-${randomUUID().replace(/-/g, '').slice(0, 16)}`);
}

function assertOwner(info: { uid: number | bigint }, label: string) {
  const getuid = process.getuid;
  if (typeof getuid !== 'function') fail('ORACLE_OWNER_UNVERIFIED', label + ' ownership cannot be verified on this platform.');
  const uid = getuid();
  if (typeof info.uid === 'bigint' ? info.uid !== BigInt(uid) : info.uid !== uid) {
    fail('ORACLE_OWNER_UNSAFE', label + ' is not owned by the current user.');
  }
}

function numericStatMode(mode: number | bigint, label: string) {
  if (typeof mode === 'bigint') {
    if (mode < 0n || mode > BigInt(Number.MAX_SAFE_INTEGER)) {
      fail('ORACLE_PERMISSIONS_UNSAFE', label + ' has an invalid filesystem mode.');
    }
    return Number(mode);
  }
  if (!Number.isSafeInteger(mode) || mode < 0) {
    fail('ORACLE_PERMISSIONS_UNSAFE', label + ' has an invalid filesystem mode.');
  }
  return mode;
}

function assertOwnerDirectory(info: Stats, label: string) {
  if (info.isSymbolicLink() || !info.isDirectory()) fail('ORACLE_PATH_UNSAFE', label + ' must be a real directory, not a symlink.');
  assertOwner(info, label);
  if ((numericStatMode(info.mode, label) & 0o022) !== 0) fail('ORACLE_PERMISSIONS_UNSAFE', label + ' must not be group/world writable.');
}

async function inspectOwnerDirectory(dir: string, label: string) {
  try {
    const info = await lstat(dir);
    assertOwnerDirectory(info, label);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function oracleSessionDir(homeDir: string, slug: string) {
  return path.join(homeDir, '.oracle', 'sessions', slug);
}

function oracleMetaPath(homeDir: string, slug: string) {
  return path.join(oracleSessionDir(homeDir, slug), 'meta.json');
}

function recoveryReceipt(
  profile: ModelProfile,
  target: OracleProfileTarget,
  slug: string,
  oraclePath: string,
  reason: string,
  promptSubmitted: boolean | null,
  conversationIdSha256?: string
) {
  return {
    ok: false as const,
    recovery_required: true as const,
    profile,
    requested_model: target.model,
    requested_effort: target.thinking,
    slug,
    prompt_submitted: promptSubmitted,
    ...(conversationIdSha256 ? { conversation_id_sha256: conversationIdSha256 } : {}),
    recovery_reason: reason,
    recovery_argv: [oraclePath, 'session', slug]
  };
}

function unboundJournalRecoveryReceipt(slug: string, oraclePath: string) {
  return {
    ok: false as const,
    recovery_required: true as const,
    profile: null,
    requested_model: null,
    requested_effort: null,
    slug,
    prompt_submitted: null,
    recovery_reason: 'existing-run-journal-unverifiable' as const,
    recovery_argv: [oraclePath, 'session', slug]
  };
}

async function readOwnerControlledMeta(homeDir: string, slug: string) {
  const home = await realpath(homeDir);
  for (const [dir, label] of [
    [home, 'Oracle home'],
    [path.join(home, '.oracle'), 'Oracle state directory'],
    [path.join(home, '.oracle', 'sessions'), 'Oracle sessions directory'],
    [oracleSessionDir(home, slug), 'Oracle session directory']
  ] as const) {
    const info = await lstat(dir);
    assertOwnerDirectory(info, label);
  }

  const target = oracleMetaPath(home, slug);
  const before = await lstat(target);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    fail('ORACLE_META_UNSAFE', 'Oracle meta.json must be one regular non-symlink file.');
  }
  assertOwner(before, 'Oracle meta.json');
  if ((numericStatMode(before.mode, 'Oracle meta.json') & 0o077) !== 0) fail('ORACLE_META_UNSAFE', 'Oracle meta.json must not be accessible to group/other users.');
  if (before.size < 2 || before.size > ORACLE_SESSION_META_MAX_BYTES) {
    fail('ORACLE_META_UNSAFE', 'Oracle meta.json size is outside the accepted evidence bound.');
  }

  const handle = await open(target, 'r');
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      fail('ORACLE_META_RACE', 'Oracle meta.json changed while it was being opened.');
    }
    const text = await handle.readFile('utf8');
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      fail('ORACLE_META_RACE', 'Oracle meta.json changed while it was being read.');
    }
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { fail('ORACLE_META_INVALID', 'Oracle meta.json is not valid JSON.'); }
    return { value, mtimeMs: before.mtimeMs };
  } finally {
    await handle.close();
  }
}

function oracleObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('ORACLE_META_INVALID', field + ' must be an object.');
  }
  return value as Record<string, unknown>;
}

function oracleString(value: unknown, field: string) {
  if (typeof value !== 'string' || !value || value.length > 512 || CONTROL.test(value)) {
    fail('ORACLE_META_INVALID', field + ' must be a nonempty control-free string.');
  }
  return value;
}

function oracleSelection(meta: Record<string, unknown>, runtime: Record<string, unknown>, field: 'modelSelection' | 'thinkingSelection') {
  const top = meta[field];
  const nested = runtime[field];
  if (top !== undefined && nested !== undefined && !isDeepStrictEqual(top, nested)) {
    fail('ORACLE_META_CONTRADICTORY', `Oracle ${field} appears twice with contradictory values.`);
  }
  return oracleObject(top ?? nested, field);
}

function oraclePromptSubmitted(meta: Record<string, unknown>) {
  const runtime = oracleObject(meta.runtime, 'runtime');
  if (typeof runtime.promptSubmitted !== 'boolean') {
    fail('ORACLE_META_INVALID', 'runtime.promptSubmitted must be a boolean.');
  }
  return { runtime, promptSubmitted: runtime.promptSubmitted };
}

function oracleConversationId(meta: Record<string, unknown>, runtime: Record<string, unknown>, browser: Record<string, unknown>) {
  const candidates = [meta.conversationId, runtime.conversationId, browser.conversationId].filter(value => value !== undefined);
  if (candidates.length === 0) fail('ORACLE_CONVERSATION_UNPROVEN', 'Oracle metadata does not expose a conversation ID to bind the receipt.');
  const values = candidates.map((value, index) => oracleString(value, `conversationId[${index}]`));
  if (values.some(value => value !== values[0])) fail('ORACLE_META_CONTRADICTORY', 'Oracle conversation IDs disagree across metadata sections.');
  return values[0];
}

function verifyOracleCompletedMeta(value: unknown, slug: string, target: OracleProfileTarget) {
  const meta = oracleObject(value, 'meta');
  const { runtime, promptSubmitted } = oraclePromptSubmitted(meta);
  if (!promptSubmitted) fail('ORACLE_PROMPT_NOT_SUBMITTED', 'Oracle metadata proves that the prompt was not submitted.');
  if (meta.slug !== slug) fail('ORACLE_WRONG_SESSION', 'Oracle meta.json belongs to a different session slug.');
  if (meta.status !== 'completed') fail('ORACLE_NOT_COMPLETED', 'Oracle session did not complete successfully.');
  if (meta.engine !== 'browser') fail('ORACLE_ENGINE_UNVERIFIED', 'Oracle postflight does not prove the browser engine.');
  if (meta.model !== target.model) fail('ORACLE_MODEL_MISMATCH', 'Oracle top-level model does not match the requested profile.');

  const browser = oracleObject(meta.browser, 'browser');
  if (browser.engine !== undefined && browser.engine !== 'browser') fail('ORACLE_ENGINE_UNVERIFIED', 'Oracle browser configuration contradicts the browser engine.');
  if (browser.modelStrategy !== 'select') fail('ORACLE_STRATEGY_UNVERIFIED', 'Oracle browser model strategy is not exactly select.');
  if (browser.archive !== 'never') fail('ORACLE_ARCHIVE_UNVERIFIED', 'Oracle browser archive setting is not exactly never.');
  if (browser.cookieSync !== true) fail('ORACLE_AUTH_UNVERIFIED', 'Oracle metadata does not prove authenticated cookie sync.');

  const modelSelection = oracleSelection(meta, runtime, 'modelSelection');
  if (
    modelSelection.requestedModel !== target.model ||
    modelSelection.desiredModel !== target.model ||
    modelSelection.selectedModel !== target.model ||
    modelSelection.verified !== true
  ) fail('ORACLE_MODEL_SELECTION_UNVERIFIED', 'Oracle model selection is not exact and verified.');
  if (modelSelection.fallbackUsed !== false) {
    fail('ORACLE_MODEL_SELECTION_UNVERIFIED', 'Oracle model selection must explicitly prove fallbackUsed=false.');
  }

  const thinkingSelection = oracleSelection(meta, runtime, 'thinkingSelection');
  if (
    thinkingSelection.requestedLevel !== target.thinking ||
    thinkingSelection.desiredLevel !== target.thinking ||
    thinkingSelection.selectedLevel !== target.thinking ||
    thinkingSelection.verified !== true
  ) fail('ORACLE_THINKING_UNVERIFIED', 'Oracle thinking selection is not exact and verified.');
  if (thinkingSelection.fallbackUsed !== false) {
    fail('ORACLE_THINKING_UNVERIFIED', 'Oracle thinking selection must explicitly prove fallbackUsed=false.');
  }

  const conversationId = oracleConversationId(meta, runtime, browser);
  return {
    conversationIdSha256: identityHash('conversation', conversationId),
    selectedModel: target.model,
    selectedThinking: target.thinking,
    strictProEvidence: target.model === 'gpt-5-pro'
  };
}

function boundedOracleOutput() {
  const parts: Buffer[] = [];
  let bytes = 0;
  return {
    add(chunk: Buffer) {
      if (bytes >= ORACLE_CAPTURE_BYTES) return;
      const part = chunk.subarray(0, ORACLE_CAPTURE_BYTES - bytes);
      parts.push(part);
      bytes += part.length;
    },
    text() { return Buffer.concat(parts).toString('utf8'); }
  };
}

async function spawnOracle(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; errorAfterSpawn: boolean }>((resolve, reject) => {
    const stdout = boundedOracleOutput();
    const stderr = boundedOracleOutput();
    let child: ChildProcess;
    try {
      child = spawn(executable, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env });
    } catch {
      reject(new ModelPolicyError('ORACLE_START_FAILED', 'Unable to start the configured Oracle browser controller.'));
      return;
    }
    if (!child.stdout || !child.stderr) {
      child.kill();
      reject(new ModelPolicyError('ORACLE_START_FAILED', 'Oracle did not expose the required output streams.'));
      return;
    }
    let spawned = false;
    let errorAfterSpawn = false;
    let rejectedBeforeSpawn = false;
    child.once('spawn', () => { spawned = true; });
    child.stdout.on('data', (chunk: Buffer) => stdout.add(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.add(chunk));
    child.on('error', () => {
      if (spawned) errorAfterSpawn = true;
      else {
        rejectedBeforeSpawn = true;
        reject(new ModelPolicyError('ORACLE_START_FAILED', 'Unable to start the configured Oracle browser controller.'));
      }
    });
    child.on('close', (exitCode, signal) => {
      if (rejectedBeforeSpawn) return;
      resolve({ exitCode, signal, stdout: stdout.text(), stderr: stderr.text(), errorAfterSpawn });
    });
  });
}

const ORACLE_ENV_ALLOWLIST = [
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS'
] as const;

function sanitizedOracleEnv(base: NodeJS.ProcessEnv, homeDir: string) {
  const env: NodeJS.ProcessEnv = { HOME: homeDir };
  for (const key of ORACLE_ENV_ALLOWLIST) {
    const value = base[key];
    if (typeof value === 'string' && !value.includes('\0')) env[key] = value;
  }
  return env;
}

function helpOptionPresent(help: string, option: string) {
  for (const raw of help.split(/\s+/u)) {
    const token = raw.replace(/^[,(\[]+/u, '').replace(/[,\)\]}>]+$/u, '');
    if (token === option || token.startsWith(option + '=')) return true;
  }
  return false;
}

async function preflightOracleCompatibility(executable: string, cwd: string, env: NodeJS.ProcessEnv) {
  const version = await spawnOracle(executable, ['--version'], cwd, env);
  if (version.errorAfterSpawn || version.exitCode !== 0 || version.signal !== null) {
    fail('ORACLE_COMPATIBILITY_MISMATCH', 'Oracle compatibility preflight could not verify the installed version.');
  }
  const expectedVersionLine = 'Oracle CLI v' + ORACLE_SUPPORTED_VERSION;
  const exactStdout = version.stdout === expectedVersionLine || version.stdout === expectedVersionLine + '\n' || version.stdout === expectedVersionLine + '\r\n';
  if (!exactStdout || version.stderr !== '') {
    fail('ORACLE_COMPATIBILITY_MISMATCH', 'Oracle --version output must be exactly ' + expectedVersionLine + ' with no prerelease/build suffix or unrelated output.');
  }

  const help = await spawnOracle(executable, ['--help'], cwd, env);
  if (help.errorAfterSpawn || help.exitCode !== 0 || help.signal !== null) {
    fail('ORACLE_COMPATIBILITY_MISMATCH', 'Oracle compatibility preflight could not inspect supported options.');
  }
  const helpText = help.stdout + '\n' + help.stderr;
  for (const option of ORACLE_REQUIRED_HELP_OPTIONS) {
    if (!helpOptionPresent(helpText, option)) {
      fail('ORACLE_COMPATIBILITY_MISMATCH', 'Oracle v' + ORACLE_SUPPORTED_VERSION + ' help is missing required option ' + option + '.');
    }
  }
}

export async function readOraclePromptFile(filePath: string) {
  if (!filePath || filePath.length > 4096 || CONTROL.test(filePath)) {
    fail('ORACLE_PROMPT_FILE_UNSAFE', 'Oracle prompt-file path must be nonempty, control-free, and at most 4096 characters.');
  }

  let before: Stats;
  try {
    before = await lstat(filePath);
  } catch {
    fail('ORACLE_PROMPT_FILE_UNSAFE', 'Oracle prompt file cannot be inspected safely.');
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    fail('ORACLE_PROMPT_FILE_UNSAFE', 'Oracle prompt file must be a regular non-symlink file.');
  }
  if (before.size > ORACLE_PROMPT_MAX_BYTES) {
    fail('ORACLE_PROMPT_FILE_UNSAFE', 'Oracle prompt file exceeds the 1 MiB limit.');
  }
  if (typeof fsConstants.O_NOFOLLOW !== 'number' || typeof fsConstants.O_NONBLOCK !== 'number') {
    fail('ORACLE_PROMPT_FILE_UNSAFE', 'This platform cannot safely open Oracle prompt files without following symlinks.');
  }

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    fail('ORACLE_PROMPT_FILE_UNSAFE', 'Oracle prompt file could not be opened safely.');
  }

  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeMs !== before.mtimeMs ||
      opened.ctimeMs !== before.ctimeMs
    ) {
      fail('ORACLE_PROMPT_FILE_UNSAFE', 'Oracle prompt file changed while it was being opened.');
    }

    const buffer = Buffer.alloc(ORACLE_PROMPT_MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > ORACLE_PROMPT_MAX_BYTES) {
      fail('ORACLE_PROMPT_FILE_UNSAFE', 'Oracle prompt file exceeded the 1 MiB limit while being read.');
    }

    const after = await handle.stat();
    if (
      !after.isFile() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      fail('ORACLE_PROMPT_FILE_UNSAFE', 'Oracle prompt file changed while it was being read.');
    }

    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
    } catch {
      fail('ORACLE_PROMPT_FILE_UNSAFE', 'Oracle prompt file must contain valid UTF-8 text.');
    }
  } finally {
    await handle.close();
  }
}

async function validateOracleFiles(repoRoot: string, files: string[]) {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const input of files) {
    if (!input || input.length > 4096 || CONTROL.test(input)) fail('INVALID_ORACLE_FILE', 'Oracle file inputs must be nonempty control-free paths.');
    const candidate = path.resolve(repoRoot, input);
    let resolved: string;
    try { resolved = await realpath(candidate); }
    catch { fail('INVALID_ORACLE_FILE', 'Oracle file input does not exist.'); }
    if (!safeRelative(resolved, repoRoot)) fail('INVALID_ORACLE_FILE', 'Oracle file inputs must stay within the selected repository.');
    if (resolved !== candidate) fail('INVALID_ORACLE_FILE', 'Oracle file inputs must not traverse symlinks.');
    const info = await lstat(resolved);
    if (!info.isFile() || info.isSymbolicLink()) fail('INVALID_ORACLE_FILE', 'Oracle file inputs must be regular files.');
    if (!seen.has(resolved)) { seen.add(resolved); output.push(resolved); }
  }
  return output;
}

export type OracleRunReservation = {
  slug: string;
  profile: ModelProfile;
  requested_model: OracleModel;
  requested_effort: OracleThinking;
  started_at: string;
};

type OracleRunJournalData = OracleRunReservation & {
  repository: {
    root: string;
    branch: string | null;
    head: string;
  };
};

async function oracleRunJournalDir(homeDir: string) {
  const candidate = path.join(homeDir, '.repo-mcp-oracle-runs');
  await mkdir(candidate, { recursive: true, mode: 0o700 });
  const info = await lstat(candidate);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail('ORACLE_JOURNAL_UNSAFE', 'Oracle run journal must be a real directory, not a symlink.');
  }
  assertOwner(info, 'Oracle run journal directory');
  if ((numericStatMode(info.mode, 'Oracle run journal directory') & 0o077) !== 0) {
    fail('ORACLE_JOURNAL_UNSAFE', 'Oracle run journal directory must be owner-only.');
  }
  const canonical = await realpath(candidate);
  if (canonical !== candidate) {
    fail('ORACLE_JOURNAL_UNSAFE', 'Oracle run journal directory must not resolve through a path alias or symlink.');
  }
  return canonical;
}

function journalObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('ORACLE_JOURNAL_INVALID', label + ' must be an object.');
  }
  return value as Record<string, unknown>;
}

function requireJournalKeys(object: Record<string, unknown>, keys: string[], label: string) {
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (!isDeepStrictEqual(actual, expected)) {
    fail('ORACLE_JOURNAL_INVALID', label + ' has an unsupported shape.');
  }
}

function parseOracleRunJournal(value: unknown, expectedSlug: string): OracleRunJournalData {
  const envelope = journalObject(value, 'Oracle run journal');
  requireJournalKeys(envelope, ['version', 'kind', 'data'], 'Oracle run journal');
  if (envelope.version !== 1 || envelope.kind !== ORACLE_RUN_JOURNAL_KIND) {
    fail('ORACLE_JOURNAL_INVALID', 'Oracle run journal version/kind is unsupported.');
  }

  const data = journalObject(envelope.data, 'Oracle run journal data');
  requireJournalKeys(
    data,
    ['slug', 'profile', 'requested_model', 'requested_effort', 'started_at', 'repository'],
    'Oracle run journal data'
  );
  const profile = parseProfile(data.profile);
  const target = oracleTargetForProfile(profile);
  if (data.slug !== expectedSlug) fail('ORACLE_JOURNAL_INVALID', 'Oracle run journal slug does not match its filename.');
  if (data.requested_model !== target.model || data.requested_effort !== target.thinking) {
    fail('ORACLE_JOURNAL_INVALID', 'Oracle run journal profile and target are internally inconsistent.');
  }
  if (
    typeof data.started_at !== 'string' ||
    !Number.isFinite(Date.parse(data.started_at)) ||
    new Date(Date.parse(data.started_at)).toISOString() !== data.started_at
  ) {
    fail('ORACLE_JOURNAL_INVALID', 'Oracle run journal start time is invalid.');
  }

  const repository = journalObject(data.repository, 'Oracle run journal repository');
  requireJournalKeys(repository, ['root', 'branch', 'head'], 'Oracle run journal repository');
  if (
    typeof repository.root !== 'string' ||
    !path.isAbsolute(repository.root) ||
    repository.root.length > 4096 ||
    CONTROL.test(repository.root)
  ) {
    fail('ORACLE_JOURNAL_INVALID', 'Oracle run journal repository root is invalid.');
  }
  if (
    repository.branch !== null &&
    (typeof repository.branch !== 'string' || !repository.branch || repository.branch.length > 512 || CONTROL.test(repository.branch))
  ) {
    fail('ORACLE_JOURNAL_INVALID', 'Oracle run journal repository branch is invalid.');
  }
  if (typeof repository.head !== 'string' || !/^[a-f0-9]{40}$/u.test(repository.head)) {
    fail('ORACLE_JOURNAL_INVALID', 'Oracle run journal repository HEAD is invalid.');
  }

  return {
    slug: expectedSlug,
    profile,
    requested_model: target.model,
    requested_effort: target.thinking,
    started_at: data.started_at,
    repository: {
      root: repository.root,
      branch: repository.branch as string | null,
      head: repository.head
    }
  };
}

async function readExistingOracleRunJournal(homeDir: string, slug: string) {
  const dir = await oracleRunJournalDir(homeDir);
  const journalPath = path.join(dir, slug + '.json');
  const before = await lstat(journalPath);
  if (before.isSymbolicLink() || !before.isFile()) {
    fail('ORACLE_JOURNAL_UNSAFE', 'Existing Oracle run journal must be a regular non-symlink file.');
  }
  assertOwner(before, 'Existing Oracle run journal');
  if ((numericStatMode(before.mode, 'Existing Oracle run journal') & 0o077) !== 0) {
    fail('ORACLE_JOURNAL_UNSAFE', 'Existing Oracle run journal must be owner-only.');
  }
  if (before.size < 2 || before.size > ORACLE_RUN_JOURNAL_MAX_BYTES) {
    fail('ORACLE_JOURNAL_UNSAFE', 'Existing Oracle run journal size is outside the accepted bound.');
  }
  if (typeof fsConstants.O_NOFOLLOW !== 'number') {
    fail('ORACLE_JOURNAL_UNSAFE', 'This platform cannot safely open an existing Oracle run journal without following symlinks.');
  }

  const handle = await open(journalPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeMs !== before.mtimeMs ||
      opened.ctimeMs !== before.ctimeMs
    ) {
      fail('ORACLE_JOURNAL_RACE', 'Existing Oracle run journal changed while it was being opened.');
    }
    assertOwner(opened, 'Existing Oracle run journal');
    if ((numericStatMode(opened.mode, 'Existing Oracle run journal') & 0o077) !== 0) {
      fail('ORACLE_JOURNAL_UNSAFE', 'Existing Oracle run journal must remain owner-only.');
    }

    const buffer = Buffer.alloc(ORACLE_RUN_JOURNAL_MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > ORACLE_RUN_JOURNAL_MAX_BYTES) {
      fail('ORACLE_JOURNAL_UNSAFE', 'Existing Oracle run journal exceeded the accepted bound while being read.');
    }

    const after = await handle.stat();
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      fail('ORACLE_JOURNAL_RACE', 'Existing Oracle run journal changed while it was being read.');
    }
    assertOwner(after, 'Existing Oracle run journal');
    if ((numericStatMode(after.mode, 'Existing Oracle run journal') & 0o077) !== 0) {
      fail('ORACLE_JOURNAL_UNSAFE', 'Existing Oracle run journal permissions changed while it was being read.');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset)));
    } catch {
      fail('ORACLE_JOURNAL_INVALID', 'Existing Oracle run journal is not valid UTF-8 JSON.');
    }
    return parseOracleRunJournal(parsed, slug);
  } finally {
    await handle.close();
  }
}

function sameOracleRunBinding(existing: OracleRunJournalData, requested: OracleRunJournalData) {
  return (
    existing.slug === requested.slug &&
    existing.profile === requested.profile &&
    existing.requested_model === requested.requested_model &&
    existing.requested_effort === requested.requested_effort &&
    isDeepStrictEqual(existing.repository, requested.repository)
  );
}

async function reserveOracleRunJournal(homeDir: string, data: OracleRunJournalData) {
  const dir = await oracleRunJournalDir(homeDir);
  const store = await StateStore.open(dir);
  return store.create(data.slug + '.json', ORACLE_RUN_JOURNAL_KIND, data);
}

async function outputDigest(outputPath: string) {
  const before = await lstat(outputPath);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) fail('ORACLE_OUTPUT_UNSAFE', 'Oracle output must be one regular non-symlink file.');
  assertOwner(before, 'Oracle output');
  if ((numericStatMode(before.mode, 'Oracle output') & 0o022) !== 0) fail('ORACLE_OUTPUT_UNSAFE', 'Oracle output must not be group/world writable.');
  if (before.size > ORACLE_OUTPUT_MAX_BYTES) fail('ORACLE_OUTPUT_UNSAFE', 'Oracle output exceeds the accepted receipt bound.');
  const handle = await open(outputPath, 'r');
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) fail('ORACLE_OUTPUT_RACE', 'Oracle output changed while it was being opened.');
    const data = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      fail('ORACLE_OUTPUT_RACE', 'Oracle output changed while it was being read.');
    }
    return { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  } finally {
    await handle.close();
  }
}

export type OracleRunReceipt = {
  ok: true;
  profile: ModelProfile;
  requested_model: OracleModel;
  requested_effort: OracleThinking;
  slug: string;
  conversation_id_sha256: string;
  prompt_submitted: true;
  oracle_status: 'completed';
  model_selection: { verified: true; selected_model: OracleModel };
  thinking_selection: { verified: true; selected_level: OracleThinking };
  strict_pro_evidence: boolean;
  output: { bytes: number; sha256: string };
};

export type OracleRecoveryReceipt = ReturnType<typeof recoveryReceipt> | ReturnType<typeof unboundJournalRecoveryReceipt>;

export async function runOracleModelProfile(options: {
  profile: ModelProfile;
  repo: string;
  prompt: string;
  files?: string[];
  slug?: string;
  repoMcpPreattachedTab: boolean;
  browserTab: string;
  oraclePath?: string;
  homeDir?: string;
  environment?: NodeJS.ProcessEnv;
  onReserved?: (reservation: OracleRunReservation) => void | Promise<void>;
}): Promise<OracleRunReceipt | OracleRecoveryReceipt> {
  const profile = parseProfile(options.profile);
  const target = oracleTargetForProfile(profile);
  if (options.repoMcpPreattachedTab !== true) {
    fail('REPO_MCP_PREATTACHED_REQUIRED', 'Oracle cannot prove Repo MCP attachment; explicitly acknowledge the preattached-tab prerequisite before launching.');
  }
  const browserTab = validateOracleBrowserTab(options.browserTab);
  if (options.slug === undefined && options.onReserved === undefined) {
    fail('ORACLE_RESERVATION_SURFACE_REQUIRED', 'Generated Oracle slugs require a reservation callback so the slug is surfaced before the prompt-bearing launch.');
  }
  if (
    typeof options.prompt !== 'string' ||
    !options.prompt.trim() ||
    Buffer.byteLength(options.prompt, 'utf8') > ORACLE_PROMPT_MAX_BYTES ||
    options.prompt.includes('\0')
  ) {
    fail('INVALID_ORACLE_PROMPT', 'Oracle prompt must be nonempty UTF-8 text without NUL and at most 1 MiB.');
  }

  const repoRoot = await realpath(options.repo);
  const identity = await resolveIdentity(repoRoot);
  const files = await validateOracleFiles(repoRoot, options.files ?? []);
  const oraclePath = options.oraclePath ?? ORACLE_CLI_PATH;
  const homeDir = await realpath(options.homeDir ?? os.homedir());
  assertOwnerDirectory(await lstat(homeDir), 'Oracle home');
  const oracleEnv = sanitizedOracleEnv(options.environment ?? process.env, homeDir);

  // Version/help inspection is deliberately non-submitting and runs before any
  // prompt-bearing Oracle invocation or durable run reservation.
  await preflightOracleCompatibility(oraclePath, repoRoot, oracleEnv);

  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const journalData = (candidate: string): OracleRunJournalData => ({
    slug: candidate,
    profile,
    requested_model: target.model,
    requested_effort: target.thinking,
    started_at: startedAtIso,
    repository: {
      root: identity.root,
      branch: identity.branch ?? null,
      head: identity.head
    }
  });

  let slug: string;
  if (options.slug !== undefined) {
    slug = validateOracleSlug(options.slug);
    const requestedJournal = journalData(slug);
    if (!await reserveOracleRunJournal(homeDir, requestedJournal)) {
      let existingJournal: OracleRunJournalData;
      try {
        existingJournal = await readExistingOracleRunJournal(homeDir, slug);
      } catch {
        return unboundJournalRecoveryReceipt(slug, oraclePath);
      }
      const existingTarget: OracleProfileTarget = {
        model: existingJournal.requested_model,
        thinking: existingJournal.requested_effort
      };
      return recoveryReceipt(
        existingJournal.profile,
        existingTarget,
        slug,
        oraclePath,
        sameOracleRunBinding(existingJournal, requestedJournal)
          ? 'existing-run-journal'
          : 'existing-run-journal-binding-mismatch',
        null
      );
    }
  } else {
    let candidate: string | undefined;
    for (let attempt = 0; attempt < 8; attempt++) {
      const generated = newOracleSlug(profile);
      if (await reserveOracleRunJournal(homeDir, journalData(generated))) {
        candidate = generated;
        break;
      }
    }
    if (!candidate) fail('ORACLE_SLUG_COLLISION', 'Unable to atomically reserve a unique Oracle session slug.');
    slug = candidate;
  }

  const reservation: OracleRunReservation = {
    slug,
    profile,
    requested_model: target.model,
    requested_effort: target.thinking,
    started_at: startedAtIso
  };
  try {
    await options.onReserved?.(reservation);
  } catch {
    return recoveryReceipt(profile, target, slug, oraclePath, 'reservation-surface-failed', null);
  }

  if (await inspectOwnerDirectory(oracleSessionDir(homeDir, slug), 'Existing Oracle session directory')) {
    return recoveryReceipt(profile, target, slug, oraclePath, 'existing-session', null);
  }

  const outputDirCandidate = path.join(homeDir, '.repo-mcp-oracle-output');
  await mkdir(outputDirCandidate, { recursive: true, mode: 0o700 });
  assertOwnerDirectory(await lstat(outputDirCandidate), 'Repo MCP Oracle output directory');
  const outputDir = await realpath(outputDirCandidate);
  const outputPath = path.join(outputDir, slug + '.txt');
  try {
    await lstat(outputPath);
    return recoveryReceipt(profile, target, slug, oraclePath, 'existing-output', null);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const repositoryPrompt = [
    'Repository context (provided by the local Repo MCP Oracle adapter):',
    'root: ' + JSON.stringify(identity.root),
    'branch: ' + JSON.stringify(identity.branch ?? '(detached)'),
    'HEAD: ' + JSON.stringify(identity.head),
    'Oracle browser tab reference: ' + JSON.stringify(browserTab) + '. This identifies the operator-selected tab but does not prove Repo MCP is attached.',
    'Repo MCP prerequisite: Repo MCP was already attached in that exact ChatGPT tab before this run. Cookie sync does not attach the plugin.',
    'Before repository work, call repo_info and stop if root, branch, or HEAD differs from the context above. Do not substitute another repository source.',
    '',
    options.prompt
  ].join('\n');

  const args = [
    '--engine', 'browser',
    '--browser-cookie-sync',
    '--browser-model-strategy', 'select',
    '--browser-archive', 'never',
    '--model', target.model,
    '--browser-thinking-time', target.thinking,
    '--browser-tab', browserTab,
    '--slug', slug,
    '--write-output', outputPath,
    '-p', repositoryPrompt,
    ...files.flatMap(file => ['--file', file])
  ];
  if (args.includes('--force')) fail('ORACLE_INTERNAL_ERROR', 'Oracle force mode is forbidden.');

  let result: Awaited<ReturnType<typeof spawnOracle>>;
  try {
    result = await spawnOracle(oraclePath, args, repoRoot, oracleEnv);
  } catch (error) {
    if (error instanceof ModelPolicyError && error.code === 'ORACLE_START_FAILED') {
      return recoveryReceipt(profile, target, slug, oraclePath, 'launch-failed-after-reservation', null);
    }
    throw error;
  }
  const duplicateSignal = /(?:already\s+(?:exists|running)|duplicate\s+(?:session|slug)|session\s+.+\s+running)/iu.test(result.stdout + '\n' + result.stderr);

  let metaRead: Awaited<ReturnType<typeof readOwnerControlledMeta>>;
  try {
    metaRead = await readOwnerControlledMeta(homeDir, slug);
  } catch {
    if (duplicateSignal) return recoveryReceipt(profile, target, slug, oraclePath, 'duplicate-or-running-session', null);
    // Once the prompt-bearing Oracle process was launched, unreadable or absent
    // metadata cannot prove non-submission. Keep the journal and recover by slug.
    return recoveryReceipt(profile, target, slug, oraclePath, 'submission-state-unverifiable', null);
  }

  const meta = oracleObject(metaRead.value, 'meta');
  if (meta.slug !== slug) {
    return recoveryReceipt(profile, target, slug, oraclePath, 'wrong-session-metadata', null);
  }
  if (metaRead.mtimeMs < startedAt) {
    return recoveryReceipt(profile, target, slug, oraclePath, 'stale-postflight-metadata', null);
  }
  if (duplicateSignal) {
    return recoveryReceipt(profile, target, slug, oraclePath, 'duplicate-or-running-session', null);
  }

  let submission: ReturnType<typeof oraclePromptSubmitted>;
  try {
    submission = oraclePromptSubmitted(meta);
  } catch {
    return recoveryReceipt(profile, target, slug, oraclePath, 'submission-state-unverifiable', null);
  }
  const { runtime, promptSubmitted } = submission;
  if (!promptSubmitted) {
    const exactTerminalPreSubmitError =
      meta.status === 'error' &&
      result.errorAfterSpawn === false &&
      result.signal === null &&
      typeof result.exitCode === 'number' &&
      result.exitCode !== 0;
    if (exactTerminalPreSubmitError) {
      fail('ORACLE_PROMPT_NOT_SUBMITTED', 'Oracle ended in the supported terminal pre-submit error state with promptSubmitted=false.');
    }
    return recoveryReceipt(profile, target, slug, oraclePath, 'submission-state-unverifiable', null);
  }

  let conversationIdSha256: string | undefined;
  try {
    const browser = oracleObject(meta.browser, 'browser');
    conversationIdSha256 = identityHash('conversation', oracleConversationId(meta, runtime, browser));
  } catch {}

  if (result.errorAfterSpawn || result.exitCode !== 0 || result.signal !== null || meta.status !== 'completed') {
    return recoveryReceipt(profile, target, slug, oraclePath, 'submitted-run-not-cleanly-completed', true, conversationIdSha256);
  }

  let verified: ReturnType<typeof verifyOracleCompletedMeta>;
  try {
    verified = verifyOracleCompletedMeta(meta, slug, target);
  } catch {
    return recoveryReceipt(profile, target, slug, oraclePath, 'postflight-attestation-failed', true, conversationIdSha256);
  }

  let output: Awaited<ReturnType<typeof outputDigest>>;
  try {
    output = await outputDigest(outputPath);
  } catch {
    return recoveryReceipt(profile, target, slug, oraclePath, 'completion-output-unverified', true, verified.conversationIdSha256);
  }

  return {
    ok: true,
    profile,
    requested_model: target.model,
    requested_effort: target.thinking,
    slug,
    conversation_id_sha256: verified.conversationIdSha256,
    prompt_submitted: true,
    oracle_status: 'completed',
    model_selection: { verified: true, selected_model: verified.selectedModel },
    thinking_selection: { verified: true, selected_level: verified.selectedThinking },
    strict_pro_evidence: verified.strictProEvidence,
    output
  };
}
