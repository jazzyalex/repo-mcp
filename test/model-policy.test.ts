import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  MODEL_POLICY_MAX_OBSERVATION_AGE_MS,
  MODEL_POLICY_SCHEMA_VERSION,
  ModelPolicyError,
  oracleTargetForProfile,
  readOraclePromptFile,
  resolveOracleExecutable,
  recordTrustedBrowserObservation,
  resolveModelProfile,
  runOracleModelProfile,
  verifyModelSelection,
  type ModelProfile,
  type ModelSelectionContract,
  type SanitizedModelSelectionEvidence
} from '../src/model-policy.js';
import { resolveIdentity } from '../src/identity.js';
import { prepareFixture } from '../src/fixture.js';

let oracleFixtureBase: string;
let oracleRepoRoot: string;
before(async () => {
  oracleFixtureBase = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-oracle-target-')));
  oracleRepoRoot = path.join(oracleFixtureBase, 'repo');
  await prepareFixture(oracleRepoRoot);
});
after(async () => { if (oracleFixtureBase) await rm(oracleFixtureBase, { recursive: true, force: true }); });

const NOW = new Date('2026-10-04T21:00:00.000Z');
const VERIFY_NOW = new Date('2026-10-04T21:00:03.000Z');
const CONVERSATION_ID = 'conv-123';
const SESSION_ID = 'session-9';
const CHAT_CURRENT_FIXTURE = { surface: 'chat' as const, controlLabel: 'Extra High' };
const WORK_SOL_XHIGH_FIXTURE = { surface: 'work' as const, controlLabel: 'GPT-6.1 Sol Extra High' };
const WORK_ASTRA_XHIGH_FIXTURE = { surface: 'work' as const, controlLabel: 'GPT-6 Astra Extra High' };
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let selectionCounter = 1;

function nextSelectionId() {
  return `11111111-1111-4111-8111-${String(selectionCounter++).padStart(12, '0')}`;
}

async function testState(t: { after(callback: () => unknown): void }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-model-policy-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function contract(
  stateDir: string,
  profile: ModelProfile,
  surface: 'chat' | 'work' = 'work',
  extra: { conversationId?: string; sessionId?: string; selectionId?: string } = { conversationId: CONVERSATION_ID }
) {
  return resolveModelProfile(profile, surface, {
    now: NOW,
    stateDir,
    selectionId: extra.selectionId ?? nextSelectionId(),
    conversationId: extra.conversationId,
    sessionId: extra.sessionId
  });
}

function workControl(profile: ModelProfile) {
  if (profile === 'code') return 'GPT-6.1 Sol High';
  if (profile === 'code-hard' || profile === 'review') return 'GPT-6.1 Sol Extra High';
  return 'GPT-6.1 Sol Pro';
}

async function trustedEvidence(
  stateDir: string,
  c: ModelSelectionContract,
  extra: Partial<{
    surface: 'chat' | 'work';
    controlLabel: string;
    modelLabel: string;
    selectedAt: string;
    observedAt: string;
    conversationId: string;
    sessionId: string;
  }> = {}
) {
  return recordTrustedBrowserObservation({
    selectionId: c.selection_id,
    surface: extra.surface ?? c.surface,
    controlLabel: extra.controlLabel ?? (c.surface === 'work' ? workControl(c.profile) : c.expected_target_label),
    ...(extra.modelLabel !== undefined ? { modelLabel: extra.modelLabel } : {}),
    selectedAt: extra.selectedAt ?? '2026-10-04T21:00:01.000Z',
    observedAt: extra.observedAt ?? '2026-10-04T21:00:02.000Z',
    conversationId: extra.conversationId ?? CONVERSATION_ID,
    ...(extra.sessionId !== undefined ? { sessionId: extra.sessionId } : {})
  }, { stateDir, now: VERIFY_NOW });
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, error => error instanceof ModelPolicyError && error.code === code);
}

test('profiles resolve to exact fail-closed picker targets', async t => {
  const stateDir = await testState(t);
  const expected = {
    code: ['Sol', 'High', 'High'],
    'code-hard': ['Sol', 'Extra High', 'XHigh'],
    review: ['Sol', 'Extra High', 'XHigh'],
    'review-critical': ['Sol Pro', 'Pro', 'Pro'],
    brainstorm: ['Sol Pro', 'Pro', 'Pro'],
    plan: ['Sol Pro', 'Pro', 'Pro'],
    architecture: ['Sol Pro', 'Pro', 'Pro']
  } as const;

  for (const [profile, [model, control, picker]] of Object.entries(expected)) {
    const c = await contract(stateDir, profile as ModelProfile);
    assert.equal(c.expected_model_label, model);
    assert.equal(c.expected_target_label, control);
    assert.equal(c.picker_target, picker);
    assert.equal(c.required_selection_method, 'model-picker');
    assert.equal(c.required_evidence_source, 'trusted-browser-adapter-live-control');
  }
});

test('browser context is mandatory, hashed, and raw opaque identities cannot be smuggled into output', async t => {
  const stateDir = await testState(t);
  await expectCode(
    resolveModelProfile('code', 'work', { now: NOW, stateDir, selectionId: nextSelectionId() }),
    'BROWSER_CONTEXT_REQUIRED'
  );
  await expectCode(
    resolveModelProfile('code', 'work', {
      now: NOW,
      stateDir,
      selectionId: nextSelectionId(),
      conversationId: 'conv\n\"profile\":\"review\"'
    }),
    'INVALID_IDENTITY'
  );

  const opaque = '../opaque/conversation?id=abc&next=review';
  const c = await contract(stateDir, 'code', 'work', { conversationId: opaque });
  const serialized = JSON.stringify(c);
  assert.equal(serialized.includes(opaque), false);
  assert.match(c.browser_context.conversation_id_sha256 ?? '', /^[a-f0-9]{64}$/);
  assert.equal(c.browser_context.session_id_sha256, undefined);
});

test('private request state anchors the original profile, surface, timestamps and context', async t => {
  const stateDir = await testState(t);
  const c = await contract(stateDir, 'code-hard', 'work');
  const receipt = await trustedEvidence(stateDir, c);

  const downgraded = {
    ...c,
    profile: 'code',
    picker_target: 'High',
    expected_target_label: 'High'
  };
  await expectCode(
    verifyModelSelection(downgraded, receipt, { stateDir, now: VERIFY_NOW }),
    'CONTRACT_STATE_MISMATCH'
  );
  await expectCode(
    verifyModelSelection({ ...c, surface: 'chat' }, receipt, { stateDir, now: VERIFY_NOW }),
    'CONTRACT_STATE_MISMATCH'
  );
  await expectCode(
    verifyModelSelection({
      ...c,
      requested_at: '2026-10-04T20:59:59.000Z',
      expires_at: '2026-10-04T21:01:59.000Z'
    }, receipt, { stateDir, now: VERIFY_NOW }),
    'CONTRACT_STATE_MISMATCH'
  );
  await expectCode(
    verifyModelSelection({ ...c, expires_at: '2026-10-04T21:01:59.000Z' }, receipt, { stateDir, now: VERIFY_NOW }),
    'INVALID_CONTRACT'
  );
  await expectCode(
    verifyModelSelection({
      ...c,
      browser_context: { conversation_id_sha256: '0'.repeat(64) }
    }, receipt, { stateDir, now: VERIFY_NOW }),
    'CONTRACT_STATE_MISMATCH'
  );

  const result = await verifyModelSelection(c, receipt, { stateDir, now: VERIFY_NOW });
  assert.equal(result.ok, true);
  assert.equal(result.selection.profile, 'code-hard');
  assert.equal(result.selection.picker_target, 'XHigh');
});

test('self-authored or tampered evidence is not browser proof', async t => {
  const stateDir = await testState(t);
  const c = await contract(stateDir, 'code', 'work');
  const fake: SanitizedModelSelectionEvidence = {
    schema_version: MODEL_POLICY_SCHEMA_VERSION,
    selection_id: c.selection_id,
    profile: c.profile,
    surface: 'Work',
    observed_model_family: 'Sol',
    observed_model_label: 'GPT-6.1 Sol',
    observed_target_label: 'High',
    observed_control_label: 'GPT-6.1 Sol High',
    selection_method: 'model-picker',
    control_source: 'live-composer-control',
    selected_at: '2026-10-04T21:00:01.000Z',
    observed_at: '2026-10-04T21:00:02.000Z',
    browser_context: c.browser_context
  };
  await expectCode(
    verifyModelSelection(c, fake, { stateDir, now: VERIFY_NOW }),
    'UNTRUSTED_EVIDENCE'
  );

  const receipt = await trustedEvidence(stateDir, c);
  await expectCode(
    verifyModelSelection({ ...c }, {
      ...receipt,
      observed_control_label: 'GPT-6.1 Sol Extra High',
      observed_target_label: 'Extra High'
    }, { stateDir, now: VERIFY_NOW }),
    'EVIDENCE_STATE_MISMATCH'
  );
  await expectCode(
    verifyModelSelection({ ...c }, { ...receipt, observed_target_label: 'Extra High' }, { stateDir, now: VERIFY_NOW }),
    'INVALID_EVIDENCE'
  );
  await expectCode(
    verifyModelSelection({ ...c }, { ...receipt, observed_at: '2026-10-04T21:00:01.500Z' }, { stateDir, now: VERIFY_NOW }),
    'EVIDENCE_STATE_MISMATCH'
  );
  await expectCode(
    verifyModelSelection({ ...c }, { ...receipt, selection_id: nextSelectionId() }, { stateDir, now: VERIFY_NOW }),
    'EVIDENCE_STATE_MISMATCH'
  );
  await expectCode(
    verifyModelSelection({ ...c }, { ...receipt, selection_method: 'script' }, { stateDir, now: VERIFY_NOW }),
    'INVALID_EVIDENCE'
  );
  await expectCode(
    verifyModelSelection({ ...c }, { ...receipt, control_source: 'caller-json' }, { stateDir, now: VERIFY_NOW }),
    'INVALID_EVIDENCE'
  );
  await verifyModelSelection(c, receipt, { stateDir, now: VERIFY_NOW });
});

test('successful authorization is atomically one-use and identical replay fails', async t => {
  const stateDir = await testState(t);
  const c = await contract(stateDir, 'review', 'work');
  const receipt = await trustedEvidence(stateDir, c);
  assert.equal((await verifyModelSelection(c, receipt, { stateDir, now: VERIFY_NOW })).ok, true);
  await expectCode(
    verifyModelSelection(c, receipt, { stateDir, now: VERIFY_NOW }),
    'SELECTION_ALREADY_CONSUMED'
  );
});

test('concurrent verification permits exactly one consumer', async t => {
  const stateDir = await testState(t);
  const c = await contract(stateDir, 'review', 'work');
  const receipt = await trustedEvidence(stateDir, c);
  const settled = await Promise.allSettled([
    verifyModelSelection(c, receipt, { stateDir, now: VERIFY_NOW }),
    verifyModelSelection(c, receipt, { stateDir, now: VERIFY_NOW })
  ]);
  assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = settled.find(result => result.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected');
  assert.ok(rejected.reason instanceof ModelPolicyError);
  assert.equal(rejected.reason.code, 'SELECTION_ALREADY_CONSUMED');
});

test('post-consume freshness is revalidated and stale authorization remains spent', async t => {
  const stateDir = await testState(t);

  const fresh = await contract(stateDir, 'code', 'work');
  const freshReceipt = await trustedEvidence(stateDir, fresh);
  const freshTimes = [
    new Date('2026-10-04T21:00:03.000Z'),
    new Date('2026-10-04T21:00:04.000Z')
  ];
  let freshRead = 0;
  const freshResult = await verifyModelSelection(fresh, freshReceipt, {
    stateDir,
    now: () => freshTimes[Math.min(freshRead++, freshTimes.length - 1)]
  });
  assert.equal(freshResult.verified_at, '2026-10-04T21:00:04.000Z');

  const ageCross = await contract(stateDir, 'review', 'work');
  const ageReceipt = await trustedEvidence(stateDir, ageCross);
  const ageTimes = [
    new Date('2026-10-04T21:00:12.000Z'),
    new Date('2026-10-04T21:00:12.001Z')
  ];
  let ageRead = 0;
  await expectCode(
    verifyModelSelection(ageCross, ageReceipt, {
      stateDir,
      now: () => ageTimes[Math.min(ageRead++, ageTimes.length - 1)]
    }),
    'OBSERVATION_TOO_OLD'
  );
  await expectCode(
    verifyModelSelection(ageCross, ageReceipt, { stateDir, now: VERIFY_NOW }),
    'SELECTION_ALREADY_CONSUMED'
  );

  const expiryCross = await contract(stateDir, 'code', 'work');
  const expiryReceipt = await recordTrustedBrowserObservation({
    selectionId: expiryCross.selection_id,
    surface: 'work',
    controlLabel: 'GPT-6.1 Sol High',
    selectedAt: '2026-10-04T21:01:58.000Z',
    observedAt: '2026-10-04T21:01:59.000Z',
    conversationId: CONVERSATION_ID
  }, { stateDir, now: new Date('2026-10-04T21:01:59.000Z') });
  const expiryTimes = [
    new Date('2026-10-04T21:01:59.999Z'),
    new Date('2026-10-04T21:02:00.001Z')
  ];
  let expiryRead = 0;
  await expectCode(
    verifyModelSelection(expiryCross, expiryReceipt, {
      stateDir,
      now: () => expiryTimes[Math.min(expiryRead++, expiryTimes.length - 1)]
    }),
    'STALE_CONTRACT'
  );
  await expectCode(
    verifyModelSelection(expiryCross, expiryReceipt, {
      stateDir,
      now: new Date('2026-10-04T21:01:59.999Z')
    }),
    'SELECTION_ALREADY_CONSUMED'
  );
});

test('live-control observation age has an explicit short boundary independent of contract TTL', async t => {
  assert.equal(MODEL_POLICY_MAX_OBSERVATION_AGE_MS, 10_000);
  const stateDir = await testState(t);

  const exact = await contract(stateDir, 'code', 'work');
  const exactReceipt = await trustedEvidence(stateDir, exact);
  assert.equal((await verifyModelSelection(exact, exactReceipt, {
    stateDir,
    now: new Date('2026-10-04T21:00:12.000Z')
  })).ok, true);

  const tooOld = await contract(stateDir, 'code', 'work');
  const oldReceipt = await trustedEvidence(stateDir, tooOld);
  await expectCode(
    verifyModelSelection(tooOld, oldReceipt, {
      stateDir,
      now: new Date('2026-10-04T21:00:12.001Z')
    }),
    'OBSERVATION_TOO_OLD'
  );
});

test('sanitized Chat fixture represents missing model-family evidence honestly and fails closed', async t => {
  const stateDir = await testState(t);
  const c = await contract(stateDir, 'review', CHAT_CURRENT_FIXTURE.surface);
  const receipt = await trustedEvidence(stateDir, c, { controlLabel: CHAT_CURRENT_FIXTURE.controlLabel });
  assert.equal(receipt.observed_model_family, null);
  assert.equal(receipt.observed_model_label, null);
  assert.equal(receipt.observed_target_label, 'Extra High');
  await expectCode(
    verifyModelSelection(c, receipt, { stateDir, now: VERIFY_NOW }),
    'MODEL_UNPROVEN'
  );

  const proven = await contract(stateDir, 'review', 'chat');
  const provenReceipt = await trustedEvidence(stateDir, proven, {
    controlLabel: 'Extra High',
    modelLabel: 'GPT-5.6 Sol'
  });
  assert.equal((await verifyModelSelection(proven, provenReceipt, { stateDir, now: VERIFY_NOW })).ok, true);
});

test('sanitized Work fixtures allowlist versioned Sol, reject Astra, and never promote Light', async t => {
  const stateDir = await testState(t);

  const review = await contract(stateDir, 'review', WORK_SOL_XHIGH_FIXTURE.surface);
  const reviewReceipt = await trustedEvidence(stateDir, review, { controlLabel: WORK_SOL_XHIGH_FIXTURE.controlLabel });
  assert.equal(reviewReceipt.observed_model_family, 'Sol');
  assert.equal(reviewReceipt.observed_model_label, 'GPT-6.1 Sol');
  assert.equal(reviewReceipt.observed_target_label, 'Extra High');
  assert.equal((await verifyModelSelection(review, reviewReceipt, { stateDir, now: VERIFY_NOW })).ok, true);

  const code = await contract(stateDir, 'code', 'work');
  const codeReceipt = await trustedEvidence(stateDir, code, { controlLabel: 'GPT-5.6 Sol High' });
  assert.equal((await verifyModelSelection(code, codeReceipt, { stateDir, now: VERIFY_NOW })).ok, true);

  const astra = await contract(stateDir, 'review', WORK_ASTRA_XHIGH_FIXTURE.surface);
  await expectCode(
    trustedEvidence(stateDir, astra, { controlLabel: WORK_ASTRA_XHIGH_FIXTURE.controlLabel }),
    'UNSUPPORTED_MODEL_LABEL'
  );

  const future = await contract(stateDir, 'review', 'work');
  await expectCode(
    trustedEvidence(stateDir, future, { controlLabel: 'GPT-6.2 Sol Extra High' }),
    'UNSUPPORTED_MODEL_LABEL'
  );

  const light = await contract(stateDir, 'code', 'work');
  const lightReceipt = await trustedEvidence(stateDir, light, { controlLabel: 'GPT-6.1 Sol Light' });
  assert.equal(lightReceipt.observed_model_family, 'Sol');
  assert.equal(lightReceipt.observed_target_label, 'Light');
  await expectCode(
    verifyModelSelection(light, lightReceipt, { stateDir, now: VERIFY_NOW }),
    'TARGET_MISMATCH'
  );
});

test('High and Extra High remain distinct with no silent downgrade or promotion', async t => {
  const stateDir = await testState(t);
  const high = await contract(stateDir, 'code', 'work');
  const highWrong = await trustedEvidence(stateDir, high, { controlLabel: 'GPT-6.1 Sol Extra High' });
  await expectCode(
    verifyModelSelection(high, highWrong, { stateDir, now: VERIFY_NOW }),
    'TARGET_MISMATCH'
  );

  const xhigh = await contract(stateDir, 'code-hard', 'work');
  const xhighWrong = await trustedEvidence(stateDir, xhigh, { controlLabel: 'GPT-6.1 Sol High' });
  await expectCode(
    verifyModelSelection(xhigh, xhighWrong, { stateDir, now: VERIFY_NOW }),
    'TARGET_MISMATCH'
  );
});

test('Sol Pro remains distinct from effort-only Extra High', async t => {
  const stateDir = await testState(t);
  const critical = await contract(stateDir, 'review-critical', 'work');
  const wrong = await trustedEvidence(stateDir, critical, { controlLabel: 'GPT-6.1 Sol Extra High' });
  await expectCode(
    verifyModelSelection(critical, wrong, { stateDir, now: VERIFY_NOW }),
    'MODEL_MISMATCH'
  );

  const correct = await contract(stateDir, 'review-critical', 'work');
  const correctReceipt = await trustedEvidence(stateDir, correct, { controlLabel: 'GPT-6.1 Sol Pro' });
  assert.equal(correctReceipt.observed_model_family, 'Sol Pro');
  assert.equal(correctReceipt.observed_target_label, 'Pro');
  assert.equal((await verifyModelSelection(correct, correctReceipt, { stateDir, now: VERIFY_NOW })).ok, true);
});

test('trusted observation must match the exact bound browser context and emits only hashed identities', async t => {
  const stateDir = await testState(t);
  const c = await contract(stateDir, 'code-hard', 'work', {
    conversationId: CONVERSATION_ID,
    sessionId: SESSION_ID
  });
  await expectCode(
    trustedEvidence(stateDir, c, { conversationId: 'conv-other', sessionId: SESSION_ID }),
    'BROWSER_CONTEXT_MISMATCH'
  );
  await expectCode(
    trustedEvidence(stateDir, c, { conversationId: CONVERSATION_ID }),
    'BROWSER_CONTEXT_MISMATCH'
  );

  const receipt = await trustedEvidence(stateDir, c, {
    conversationId: CONVERSATION_ID,
    sessionId: SESSION_ID
  });
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes(CONVERSATION_ID), false);
  assert.equal(serialized.includes(SESSION_ID), false);
  assert.deepEqual(receipt.browser_context, c.browser_context);
});

test('verified output retains only sanitized contract-bound evidence', async t => {
  const stateDir = await testState(t);
  const c = await contract(stateDir, 'code', 'work');
  const receipt = await recordTrustedBrowserObservation({
    selectionId: c.selection_id,
    surface: 'work',
    controlLabel: 'GPT-6.1 Sol High',
    selectedAt: '2026-10-04T21:00:01.000Z',
    observedAt: '2026-10-04T21:00:02.000Z',
    conversationId: CONVERSATION_ID,
    cookie: 'do-not-retain',
    token: 'do-not-retain',
    prompt: 'do-not-retain'
  } as Parameters<typeof recordTrustedBrowserObservation>[0], { stateDir, now: VERIFY_NOW });
  const result = await verifyModelSelection(c, receipt, { stateDir, now: VERIFY_NOW });
  assert.equal(JSON.stringify(result).includes('do-not-retain'), false);
  assert.deepEqual(Object.keys(result.evidence).sort(), [
    'browser_context',
    'control_source',
    'observed_at',
    'observed_control_label',
    'observed_model_family',
    'observed_model_label',
    'observed_target_label',
    'profile',
    'schema_version',
    'selected_at',
    'selection_id',
    'selection_method',
    'surface'
  ].sort());
});

test('CLI uses private owner state, requires trusted observation, and consumes authorization once', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-model-policy-cli-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const xdgState = path.join(base, '.xdg-state');
  const env = { ...process.env, HOME: base, XDG_STATE_HOME: xdgState };
  const stateDir = process.platform === 'darwin'
    ? path.join(base, 'Library', 'Application Support', 'repo-mcp', 'state', 'model-policy')
    : path.join(xdgState, 'repo-mcp', 'model-policy');

  const resolvedProcess = spawnSync(process.execPath, [
    '--import', 'tsx', path.join(projectRoot, 'scripts/model-policy.ts'),
    'resolve', '--profile', 'code', '--surface', 'work', '--conversation-id', 'conv-cli'
  ], { cwd: projectRoot, encoding: 'utf8', env });
  assert.equal(resolvedProcess.status, 0, resolvedProcess.stderr || resolvedProcess.stdout);
  const resolved = JSON.parse(resolvedProcess.stdout) as { ok: boolean; contract: ModelSelectionContract };
  assert.equal(resolved.ok, true);

  const contractPath = path.join(base, 'contract.json');
  const evidencePath = path.join(base, 'evidence.json');
  await writeFile(contractPath, JSON.stringify(resolved));

  const fakeEvidence: SanitizedModelSelectionEvidence = {
    schema_version: MODEL_POLICY_SCHEMA_VERSION,
    selection_id: resolved.contract.selection_id,
    profile: 'code',
    surface: 'Work',
    observed_model_family: 'Sol',
    observed_model_label: 'GPT-6.1 Sol',
    observed_target_label: 'High',
    observed_control_label: 'GPT-6.1 Sol High',
    selection_method: 'model-picker',
    control_source: 'live-composer-control',
    selected_at: resolved.contract.requested_at,
    observed_at: resolved.contract.requested_at,
    browser_context: resolved.contract.browser_context
  };
  await writeFile(evidencePath, JSON.stringify(fakeEvidence));
  const untrusted = spawnSync(process.execPath, [
    '--import', 'tsx', path.join(projectRoot, 'scripts/model-policy.ts'),
    'verify', '--contract-file', contractPath, '--evidence-file', evidencePath
  ], { cwd: projectRoot, encoding: 'utf8', env });
  assert.notEqual(untrusted.status, 0);
  assert.equal((JSON.parse(untrusted.stdout) as { error: { code: string } }).error.code, 'UNTRUSTED_EVIDENCE');

  const observationNow = new Date();
  const receipt = await recordTrustedBrowserObservation({
    selectionId: resolved.contract.selection_id,
    surface: 'work',
    controlLabel: 'GPT-6.1 Sol High',
    selectedAt: resolved.contract.requested_at,
    observedAt: observationNow.toISOString(),
    conversationId: 'conv-cli'
  }, { stateDir, now: observationNow });
  await writeFile(evidencePath, JSON.stringify(receipt));

  const verified = spawnSync(process.execPath, [
    '--import', 'tsx', path.join(projectRoot, 'scripts/model-policy.ts'),
    'verify', '--contract-file', contractPath, '--evidence-file', evidencePath
  ], { cwd: projectRoot, encoding: 'utf8', env });
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  assert.equal((JSON.parse(verified.stdout) as { ok: boolean }).ok, true);

  const replay = spawnSync(process.execPath, [
    '--import', 'tsx', path.join(projectRoot, 'scripts/model-policy.ts'),
    'verify', '--contract-file', contractPath, '--evidence-file', evidencePath
  ], { cwd: projectRoot, encoding: 'utf8', env });
  assert.notEqual(replay.status, 0);
  assert.equal((JSON.parse(replay.stdout) as { error: { code: string } }).error.code, 'SELECTION_ALREADY_CONSUMED');
});

type FakeOracleConfig = {
  mode?: string;
  capture?: string;
  count?: string;
};

async function fakeOracleFixture(t: { after(callback: () => unknown): void }) {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-fake-oracle-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const executable = path.join(home, 'fake-oracle.mjs');
  const configPath = path.join(home, '.fake-oracle-config.json');
  const script = `#!${process.execPath}\n` + String.raw`
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const configPath = path.join(process.env.HOME, '.fake-oracle-config.json');
let config = {};
try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
const mode = config.mode || 'success';
const supported = [
  '--engine',
  '--browser-cookie-sync',
  '--browser-model-strategy',
  '--browser-archive',
  '--model',
  '--browser-thinking-time',
  '--slug',
  '--write-output',
  '--browser-tab',
  '--file',
  '-p'
];
if (args.length === 1 && args[0] === '--version') {
  const versions = {
    'bad-version': 'Oracle CLI v0.21.0\n',
    'version-beta': 'Oracle CLI v0.21.1-beta.1\n',
    'version-build': 'Oracle CLI v0.21.1+build.7\n',
    'version-multiple': 'Oracle CLI v0.21.1\nOracle CLI v0.21.0\n',
    'version-malformed-label': 'Oracle version v0.21.1\n',
    'version-wrapped': 'notice: Oracle CLI v0.21.1 ready\n'
  };
  process.stdout.write(versions[mode] || 'Oracle CLI v0.21.1\n');
  process.exit(0);
}
if (args.length === 1 && args[0] === '--help') {
  const shown = mode === 'missing-help-option' ? supported.filter(option => option !== '--browser-tab') : supported;
  process.stdout.write(shown.join('\n') + '\n');
  process.exit(0);
}
const value = flag => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const slug = value('--slug');
const model = value('--model');
const thinking = value('--browser-thinking-time');
const output = value('--write-output');
const browserTab = value('--browser-tab');
if (config.count) {
  fs.appendFileSync(config.count, '1', { mode: 0o600 });
}
if (config.capture) {
  fs.writeFileSync(config.capture, JSON.stringify({
    args,
    cwd: process.cwd(),
    env: {
      HOME: process.env.HOME ?? null,
      PATH: process.env.PATH ?? null,
      TMPDIR: process.env.TMPDIR ?? null,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,
      OPENAI_API_BASE: process.env.OPENAI_API_BASE ?? null,
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? null,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,
      HTTPS_PROXY: process.env.HTTPS_PROXY ?? null,
      HTTP_PROXY: process.env.HTTP_PROXY ?? null,
      ALL_PROXY: process.env.ALL_PROXY ?? null,
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? null,
      ORACLE_ENGINE: process.env.ORACLE_ENGINE ?? null,
      ORACLE_MODEL: process.env.ORACLE_MODEL ?? null,
      ORACLE_BROWSER_MODEL_STRATEGY: process.env.ORACLE_BROWSER_MODEL_STRATEGY ?? null,
      RANDOM_SENTINEL: process.env.RANDOM_SENTINEL ?? null
    }
  }), { mode: 0o600 });
}
if (!slug || !model || !thinking || !output || !browserTab) process.exit(64);
const journal = path.join(process.env.HOME, '.repo-mcp-oracle-runs', slug + '.json');
if (mode === 'assert-journal' && !fs.existsSync(journal)) process.exit(70);
if (mode === 'missing-meta') {
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  fs.writeFileSync(output, 'output without metadata', { mode: 0o600 });
  process.exit(0);
}
const oracle = path.join(process.env.HOME, '.oracle');
const sessions = path.join(oracle, 'sessions');
const session = path.join(sessions, slug);
for (const directory of [oracle, sessions, session]) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}
fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
const falseSubmissionModes = new Set(['no-submit', 'false-completed', 'false-running', 'false-unknown', 'false-error-zero']);
const promptSubmitted = !falseSubmissionModes.has(mode);
let status = 'completed';
if (mode === 'submitted-error' || mode === 'no-submit' || mode === 'false-error-zero') status = 'error';
if (mode === 'false-running' || mode === 'interrupted-after-spawn') status = 'running';
if (mode === 'false-unknown') status = 'mystery';
const modelSelection = {
  requestedModel: model,
  desiredModel: model,
  selectedModel: model,
  verified: true,
  fallbackUsed: false
};
const thinkingSelection = {
  requestedLevel: thinking,
  desiredLevel: thinking,
  selectedLevel: thinking,
  verified: true,
  fallbackUsed: false
};
const meta = {
  slug,
  status,
  engine: 'browser',
  model,
  browser: {
    engine: 'browser',
    modelStrategy: 'select',
    archive: 'never',
    cookieSync: true,
    conversationId: 'conv-fake-123'
  },
  runtime: {
    promptSubmitted,
    conversationId: 'conv-fake-123'
  },
  modelSelection,
  thinkingSelection,
  cookie: 'COOKIE_SENTINEL_SHOULD_NOT_ESCAPE',
  endpoint: 'wss://secret.invalid/socket',
  token: 'TOKEN_SENTINEL_SHOULD_NOT_ESCAPE',
  prompt: 'RAW_PROMPT_SENTINEL_SHOULD_NOT_ESCAPE'
};
if (mode === 'wrong-session') meta.slug = slug + '-other';
if (mode === 'wrong-model') meta.model = model === 'gpt-5-pro' ? 'gpt-5.6-sol' : 'gpt-5-pro';
if (mode === 'unverified-model') meta.modelSelection.verified = false;
if (mode === 'weak-pro') delete meta.modelSelection.selectedModel;
if (mode === 'wrong-thinking') meta.thinkingSelection.selectedLevel = thinking === 'pro' ? 'extra-high' : 'pro';
if (mode === 'contradictory') meta.runtime.modelSelection = { ...meta.modelSelection, selectedModel: 'gpt-5-pro' };
if (mode === 'model-fallback-missing') delete meta.modelSelection.fallbackUsed;
if (mode === 'model-fallback-null') meta.modelSelection.fallbackUsed = null;
if (mode === 'model-fallback-true') meta.modelSelection.fallbackUsed = true;
if (mode === 'model-fallback-string') meta.modelSelection.fallbackUsed = 'false';
if (mode === 'thinking-fallback-missing') delete meta.thinkingSelection.fallbackUsed;
if (mode === 'thinking-fallback-null') meta.thinkingSelection.fallbackUsed = null;
if (mode === 'thinking-fallback-true') meta.thinkingSelection.fallbackUsed = true;
if (mode === 'thinking-fallback-string') meta.thinkingSelection.fallbackUsed = 'false';
if (mode === 'no-conversation') {
  delete meta.browser.conversationId;
  delete meta.runtime.conversationId;
}
const metaPath = path.join(session, 'meta.json');
if (mode === 'malformed') {
  fs.writeFileSync(metaPath, '{', { mode: 0o600 });
} else if (mode === 'symlink-meta') {
  const realMeta = path.join(session, 'real-meta.json');
  fs.writeFileSync(realMeta, JSON.stringify(meta), { mode: 0o600 });
  fs.symlinkSync(realMeta, metaPath);
} else {
  fs.writeFileSync(metaPath, JSON.stringify(meta), { mode: 0o600 });
  if (mode === 'unsafe-permissions') fs.chmodSync(metaPath, 0o644);
  if (mode === 'stale') fs.utimesSync(metaPath, new Date(0), new Date(0));
}
if (mode !== 'missing-output') fs.writeFileSync(output, 'SAFE_OUTPUT_CONTENT', { mode: 0o600 });
if (mode === 'interrupted-after-spawn') process.kill(process.pid, 'SIGTERM');
if (mode === 'submitted-error' || mode === 'no-submit') process.exit(7);
process.exit(0);
`;
  await writeFile(executable, script, { mode: 0o700 });
  await chmod(executable, 0o700);
  return {
    home,
    executable,
    async configure(config: FakeOracleConfig) {
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    }
  };
}

function fakeEnvironment(home: string, extra: NodeJS.ProcessEnv = {}) {
  return {
    ...process.env,
    HOME: home,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    OPENAI_API_KEY: 'must-not-reach-fake-oracle',
    OPENAI_API_BASE: 'https://api-base.invalid',
    OPENAI_BASE_URL: 'https://base-url.invalid',
    ANTHROPIC_API_KEY: 'must-not-reach-fake-oracle',
    HTTPS_PROXY: 'http://proxy.invalid',
    HTTP_PROXY: 'http://proxy.invalid',
    ALL_PROXY: 'socks://proxy.invalid',
    NODE_OPTIONS: '--require=/tmp/never.js',
    ORACLE_ENGINE: 'api',
    ORACLE_MODEL: 'must-not-reach-fake-oracle',
    ORACLE_BROWSER_MODEL_STRATEGY: 'fallback',
    RANDOM_SENTINEL: 'must-not-reach-fake-oracle',
    ...extra
  };
}

async function writeExistingOracleJournal(
  home: string,
  slug: string,
  options: {
    profile?: ModelProfile;
    repositoryRoot?: string;
    malformed?: boolean;
    unsafePermissions?: boolean;
    symlinked?: boolean;
  } = {}
) {
  const profile = options.profile ?? 'code';
  const target = oracleTargetForProfile(profile);
  const identity = await resolveIdentity(oracleRepoRoot);
  const journalDir = path.join(await realpath(home), '.repo-mcp-oracle-runs');
  await mkdir(journalDir, { recursive: true, mode: 0o700 });
  await chmod(journalDir, 0o700);
  const journalPath = path.join(journalDir, slug + '.json');
  const record = {
    version: 1,
    kind: 'oracle-run-journal-v1',
    data: {
      slug,
      profile,
      requested_model: target.model,
      requested_effort: target.thinking,
      started_at: '2026-10-05T02:00:00.000Z',
      repository: {
        root: options.repositoryRoot ?? identity.root,
        branch: identity.branch,
        head: identity.head
      }
    }
  };
  const serialized = JSON.stringify(record) + '\n';

  if (options.malformed) {
    await writeFile(journalPath, '{', { mode: 0o600 });
  } else if (options.symlinked) {
    const realJournal = path.join(journalDir, slug + '.real.json');
    await writeFile(realJournal, serialized, { mode: 0o600 });
    await symlink(realJournal, journalPath);
  } else {
    await writeFile(journalPath, serialized, { mode: 0o600 });
    if (options.unsafePermissions) await chmod(journalPath, 0o644);
  }

  return { journalPath, serialized, record };
}

test('Oracle profile mappings are exact and never fall back', () => {
  const expected: Record<ModelProfile, { model: string; thinking: string }> = {
    code: { model: 'gpt-5.6-sol', thinking: 'high' },
    'code-hard': { model: 'gpt-5.6-sol', thinking: 'extra-high' },
    review: { model: 'gpt-5.6-sol', thinking: 'extra-high' },
    'review-critical': { model: 'gpt-5-pro', thinking: 'pro' },
    brainstorm: { model: 'gpt-5-pro', thinking: 'pro' },
    plan: { model: 'gpt-5-pro', thinking: 'pro' },
    architecture: { model: 'gpt-5-pro', thinking: 'pro' }
  };
  for (const [profile, target] of Object.entries(expected)) {
    assert.deepEqual(oracleTargetForProfile(profile as ModelProfile), target);
  }
  assert.throws(
    () => oracleTargetForProfile('unknown' as ModelProfile),
    error => error instanceof ModelPolicyError && error.code === 'UNKNOWN_PROFILE'
  );
});

test('Oracle adapter pins exact v0.21.1 argv, strips unsafe environment, requires a trusted tab ref, and emits only sanitized receipt data', async t => {
  const fixture = await fakeOracleFixture(t);
  const capture = path.join(fixture.home, 'capture.json');
  await fixture.configure({ mode: 'success', capture });
  const slug = 'oracle-test-code-01';
  const rawPrompt = 'Review this safely; --model gpt-5-pro; $(touch /tmp/never)';
  const receipt = await runOracleModelProfile({
    profile: 'code',
    repo: oracleRepoRoot,
    prompt: rawPrompt,
    files: ['package.json'],
    slug,
    repoMcpPreattachedTab: true,
    browserTab: 'tab-test-01',
    oraclePath: fixture.executable,
    homeDir: fixture.home,
    environment: fakeEnvironment(fixture.home)
  });
  assert.equal(receipt.ok, true);
  if (!receipt.ok) return;

  const captured = JSON.parse(await readFile(capture, 'utf8')) as {
    args: string[];
    cwd: string;
    env: Record<string, string | null>;
  };
  const canonicalHome = await realpath(fixture.home);
  const outputPath = path.join(canonicalHome, '.repo-mcp-oracle-output', slug + '.txt');
  const promptIndex = captured.args.indexOf('-p');
  assert.ok(promptIndex >= 0);
  const promptArg = captured.args[promptIndex + 1];
  assert.deepEqual(captured.args, [
    '--engine', 'browser',
    '--browser-cookie-sync',
    '--browser-model-strategy', 'select',
    '--browser-archive', 'never',
    '--model', 'gpt-5.6-sol',
    '--browser-thinking-time', 'high',
    '--browser-tab', 'tab-test-01',
    '--slug', slug,
    '--write-output', outputPath,
    '-p', promptArg,
    '--file', path.join(oracleRepoRoot, 'package.json')
  ]);
  assert.equal(captured.cwd, oracleRepoRoot);
  assert.equal(captured.env.HOME, canonicalHome);
  assert.equal(captured.env.PATH, process.env.PATH ?? null);
  assert.equal(captured.env.TMPDIR, process.env.TMPDIR ?? null);
  for (const key of ['OPENAI_API_KEY', 'OPENAI_API_BASE', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NODE_OPTIONS', 'ORACLE_ENGINE', 'ORACLE_MODEL', 'ORACLE_BROWSER_MODEL_STRATEGY', 'RANDOM_SENTINEL']) {
    assert.equal(captured.env[key], null, key);
  }
  assert.equal(captured.args.includes('--force'), false);
  assert.equal(captured.args.includes('--thinking'), false);
  assert.equal(captured.args.includes('--output'), false);
  assert.match(promptArg, /Repo MCP prerequisite:/);
  assert.match(promptArg, /Before repository work, call repo_info/);
  assert.ok(promptArg.endsWith(rawPrompt));
  assert.match(receipt.conversation_id_sha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.model_selection.selected_model, 'gpt-5.6-sol');
  assert.equal(receipt.thinking_selection.selected_level, 'high');
  assert.equal(receipt.prompt_submitted, true);
  const serialized = JSON.stringify(receipt);
  for (const secret of [rawPrompt, 'conv-fake-123', 'COOKIE_SENTINEL_SHOULD_NOT_ESCAPE', 'TOKEN_SENTINEL_SHOULD_NOT_ESCAPE', 'wss://secret.invalid/socket']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('Oracle CLI run rejects protected overrides and requires both acknowledgement and browser tab before launch', () => {
  const override = spawnSync(process.execPath, [
    '--import', 'tsx', path.join(projectRoot, 'scripts/model-policy.ts'),
    'run', '--profile', 'code', '--repo', oracleRepoRoot,
    '--prompt', 'safe prompt', '--repo-mcp-preattached-tab', '--browser-tab', 'tab-test-01',
    '--engine', 'api'
  ], { cwd: projectRoot, encoding: 'utf8' });
  assert.notEqual(override.status, 0);
  const parsedOverride = JSON.parse(override.stdout) as { ok: boolean; error: { code: string; message: string } };
  assert.equal(parsedOverride.ok, false);
  assert.equal(parsedOverride.error.code, 'CLI_ERROR');
  assert.match(parsedOverride.error.message, /engine|Unknown option/i);

  const missingTab = spawnSync(process.execPath, [
    '--import', 'tsx', path.join(projectRoot, 'scripts/model-policy.ts'),
    'run', '--profile', 'code', '--repo', oracleRepoRoot,
    '--prompt', 'safe prompt', '--repo-mcp-preattached-tab'
  ], { cwd: projectRoot, encoding: 'utf8' });
  assert.notEqual(missingTab.status, 0);
  const parsedMissingTab = JSON.parse(missingTab.stdout) as { ok: boolean; error: { code: string } };
  assert.equal(parsedMissingTab.error.code, 'CLI_USAGE');
});

test('Oracle compatibility preflight fails before journal reservation or prompt submission on version/help mismatch', async t => {
  for (const [index, mode] of ['bad-version', 'missing-help-option'].entries()) {
    const fixture = await fakeOracleFixture(t);
    const count = path.join(fixture.home, `preflight-count-${index}.txt`);
    await fixture.configure({ mode, count });
    await assert.rejects(
      runOracleModelProfile({
        profile: 'code',
        repo: oracleRepoRoot,
        prompt: 'must never submit',
        slug: `oracle-preflight-${index + 10}`,
        repoMcpPreattachedTab: true,
        browserTab: 'tab-test-01',
        oraclePath: fixture.executable,
        homeDir: fixture.home,
        environment: fakeEnvironment(fixture.home)
      }),
      error => error instanceof ModelPolicyError && error.code === 'ORACLE_COMPATIBILITY_MISMATCH'
    );
    await assert.rejects(readFile(count, 'utf8'), /ENOENT/);
    await assert.rejects(readFile(path.join(fixture.home, '.repo-mcp-oracle-runs', `oracle-preflight-${index + 10}.json`), 'utf8'), /ENOENT/);
  }
});

test('Oracle version preflight accepts only the exact Oracle CLI v0.21.1 release line', async t => {
  const modes = ['version-beta', 'version-build', 'version-multiple', 'version-malformed-label', 'version-wrapped'];
  for (let index = 0; index < modes.length; index++) {
    const mode = modes[index];
    const fixture = await fakeOracleFixture(t);
    const count = path.join(fixture.home, `version-shape-count-${index}.txt`);
    const slug = `oracle-version-shape-${index + 10}`;
    await fixture.configure({ mode, count });
    await assert.rejects(
      runOracleModelProfile({
        profile: 'code',
        repo: oracleRepoRoot,
        prompt: 'must never submit',
        slug,
        repoMcpPreattachedTab: true,
        browserTab: 'tab-test-01',
        oraclePath: fixture.executable,
        homeDir: fixture.home,
        environment: fakeEnvironment(fixture.home)
      }),
      error => error instanceof ModelPolicyError && error.code === 'ORACLE_COMPATIBILITY_MISMATCH'
    );
    await assert.rejects(readFile(count, 'utf8'), /ENOENT/, mode);
    await assert.rejects(readFile(path.join(fixture.home, '.repo-mcp-oracle-runs', slug + '.json'), 'utf8'), /ENOENT/, mode);
  }
});

test('Oracle postflight requires fallbackUsed exactly false for both model and thinking selections', async t => {
  const fixture = await fakeOracleFixture(t);
  const modes = [
    'model-fallback-missing',
    'model-fallback-null',
    'model-fallback-true',
    'model-fallback-string',
    'thinking-fallback-missing',
    'thinking-fallback-null',
    'thinking-fallback-true',
    'thinking-fallback-string'
  ];
  for (let index = 0; index < modes.length; index++) {
    const mode = modes[index];
    await fixture.configure({ mode });
    const result = await runOracleModelProfile({
      profile: 'review',
      repo: oracleRepoRoot,
      prompt: 'review fallback evidence',
      slug: `oracle-fallback-${String(index).padStart(2, '0')}`,
      repoMcpPreattachedTab: true,
      browserTab: 'tab-test-01',
      oraclePath: fixture.executable,
      homeDir: fixture.home,
      environment: fakeEnvironment(fixture.home)
    });
    assert.equal(result.ok, false, mode);
    if (!result.ok) {
      assert.equal(result.prompt_submitted, true, mode);
      assert.equal(result.recovery_reason, 'postflight-attestation-failed', mode);
    }
  }
});

test('promptSubmitted=false is no-submit only for the exact terminal pre-submit error state', async t => {
  const fixture = await fakeOracleFixture(t);
  for (const [index, mode] of ['false-completed', 'false-running', 'false-unknown', 'false-error-zero'].entries()) {
    await fixture.configure({ mode });
    const slug = `oracle-false-state-${index + 10}`;
    const result = await runOracleModelProfile({
      profile: 'plan',
      repo: oracleRepoRoot,
      prompt: 'plan without guessing',
      slug,
      repoMcpPreattachedTab: true,
      browserTab: 'tab-test-01',
      oraclePath: fixture.executable,
      homeDir: fixture.home,
      environment: fakeEnvironment(fixture.home)
    });
    assert.equal(result.ok, false, mode);
    if (!result.ok) {
      assert.equal(result.prompt_submitted, null, mode);
      assert.equal(result.slug, slug, mode);
      assert.equal(result.recovery_reason, 'submission-state-unverifiable', mode);
    }
  }

  const exactCount = path.join(fixture.home, 'exact-no-submit-count.txt');
  await fixture.configure({ mode: 'no-submit', count: exactCount });
  await assert.rejects(
    runOracleModelProfile({
      profile: 'plan',
      repo: oracleRepoRoot,
      prompt: 'known pre-submit failure',
      slug: 'oracle-no-submit-exact-01',
      repoMcpPreattachedTab: true,
      browserTab: 'tab-test-01',
      oraclePath: fixture.executable,
      homeDir: fixture.home,
      environment: fakeEnvironment(fixture.home)
    }),
    error => error instanceof ModelPolicyError && error.code === 'ORACLE_PROMPT_NOT_SUBMITTED'
  );
  assert.equal(await readFile(exactCount, 'utf8'), '1');
});

test('Oracle adapter rejects missing, malformed, stale, wrong-session, wrong-model, contradictory, and unverified postflight evidence without retrying', async t => {
  const fixture = await fakeOracleFixture(t);
  const modes = [
    'missing-meta',
    'malformed',
    'stale',
    'wrong-session',
    'wrong-model',
    'contradictory',
    'unverified-model',
    'wrong-thinking',
    'no-conversation',
    'missing-output'
  ];
  for (let index = 0; index < modes.length; index++) {
    const mode = modes[index];
    const count = path.join(fixture.home, `count-${index}.txt`);
    await fixture.configure({ mode, count });
    const result = await runOracleModelProfile({
      profile: 'review',
      repo: oracleRepoRoot,
      prompt: 'review current change',
      slug: `oracle-evidence-${String(index).padStart(2, '0')}`,
      repoMcpPreattachedTab: true,
      browserTab: 'tab-test-01',
      oraclePath: fixture.executable,
      homeDir: fixture.home,
      environment: fakeEnvironment(fixture.home)
    });
    assert.equal(result.ok, false, mode);
    if (result.ok) continue;
    assert.equal(result.recovery_required, true, mode);
    assert.equal(await readFile(count, 'utf8'), '1', mode);
  }
});

test('Oracle adapter rejects symlinked and unsafe-permission metadata without risking a resubmit', async t => {
  const fixture = await fakeOracleFixture(t);
  for (const [index, mode] of ['symlink-meta', 'unsafe-permissions'].entries()) {
    const count = path.join(fixture.home, `unsafe-count-${index}.txt`);
    await fixture.configure({ mode, count });
    const result = await runOracleModelProfile({
      profile: 'code',
      repo: oracleRepoRoot,
      prompt: 'code safely',
      slug: `oracle-unsafe-${index + 10}`,
      repoMcpPreattachedTab: true,
      browserTab: 'tab-test-01',
      oraclePath: fixture.executable,
      homeDir: fixture.home,
      environment: fakeEnvironment(fixture.home)
    });
    assert.equal(result.ok, false, mode);
    if (!result.ok) {
      assert.equal(result.recovery_required, true, mode);
      assert.equal(result.prompt_submitted, null, mode);
      assert.equal(result.recovery_reason, 'submission-state-unverifiable', mode);
    }
    assert.equal(await readFile(count, 'utf8'), '1', mode);
  }
});

test('Oracle Pro profiles require exact verified Pro model and thinking evidence', async t => {
  const fixture = await fakeOracleFixture(t);
  await fixture.configure({ mode: 'weak-pro' });
  const weak = await runOracleModelProfile({
    profile: 'review-critical',
    repo: oracleRepoRoot,
    prompt: 'critical review',
    slug: 'oracle-pro-weak-01',
    repoMcpPreattachedTab: true,
    browserTab: 'tab-test-01',
    oraclePath: fixture.executable,
    homeDir: fixture.home,
    environment: fakeEnvironment(fixture.home)
  });
  assert.equal(weak.ok, false);
  if (!weak.ok) assert.equal(weak.recovery_reason, 'postflight-attestation-failed');

  await fixture.configure({ mode: 'success' });
  const strong = await runOracleModelProfile({
    profile: 'review-critical',
    repo: oracleRepoRoot,
    prompt: 'critical review',
    slug: 'oracle-pro-strong-01',
    repoMcpPreattachedTab: true,
    browserTab: 'tab-test-01',
    oraclePath: fixture.executable,
    homeDir: fixture.home,
    environment: fakeEnvironment(fixture.home)
  });
  assert.equal(strong.ok, true);
  if (strong.ok) {
    assert.equal(strong.requested_model, 'gpt-5-pro');
    assert.equal(strong.requested_effort, 'pro');
    assert.equal(strong.strict_pro_evidence, true);
    assert.equal(strong.model_selection.selected_model, 'gpt-5-pro');
    assert.equal(strong.thinking_selection.selected_level, 'pro');
  }
});

test('submitted Oracle errors return recovery for the same slug and never auto-retry', async t => {
  const fixture = await fakeOracleFixture(t);
  const count = path.join(fixture.home, 'submitted-count.txt');
  await fixture.configure({ mode: 'submitted-error', count });
  const result = await runOracleModelProfile({
    profile: 'code-hard',
    repo: oracleRepoRoot,
    prompt: 'hard coding task',
    slug: 'oracle-submitted-err-01',
    repoMcpPreattachedTab: true,
    browserTab: 'tab-test-01',
    oraclePath: fixture.executable,
    homeDir: fixture.home,
    environment: fakeEnvironment(fixture.home)
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.prompt_submitted, true);
    assert.equal(result.recovery_reason, 'submitted-run-not-cleanly-completed');
    assert.deepEqual(result.recovery_argv, [fixture.executable, 'session', 'oracle-submitted-err-01']);
  }
  assert.equal(await readFile(count, 'utf8'), '1');
});

test('slug journal is durable, owner-only, created before spawn, and binds generated slug to profile/repository/start time', async t => {
  const fixture = await fakeOracleFixture(t);
  await fixture.configure({ mode: 'assert-journal' });
  let reservedSlug: string | undefined;
  const result = await runOracleModelProfile({
    profile: 'code-hard',
    repo: oracleRepoRoot,
    prompt: 'journaled coding task',
    repoMcpPreattachedTab: true,
    browserTab: 'tab-test-01',
    oraclePath: fixture.executable,
    homeDir: fixture.home,
    environment: fakeEnvironment(fixture.home),
    onReserved: reservation => { reservedSlug = reservation.slug; }
  });
  assert.equal(result.ok, true);
  assert.ok(reservedSlug);
  if (!reservedSlug) return;
  assert.equal(result.slug, reservedSlug);
  const journalDir = path.join(await realpath(fixture.home), '.repo-mcp-oracle-runs');
  const journalPath = path.join(journalDir, reservedSlug + '.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
    version: number;
    kind: string;
    data: {
      slug: string;
      profile: string;
      repository: { root: string; branch: string | null; head: string };
      started_at: string;
    };
  };
  assert.equal(journal.version, 1);
  assert.equal(journal.kind, 'oracle-run-journal-v1');
  assert.equal(journal.data.slug, reservedSlug);
  assert.equal(journal.data.profile, 'code-hard');
  assert.equal(journal.data.repository.root, oracleRepoRoot);
  assert.equal(journal.data.repository.head.length, 40);
  assert.ok(Number.isFinite(Date.parse(journal.data.started_at)));
  assert.equal((Number((await lstat(journalDir)).mode) & 0o077), 0);
  assert.equal((Number((await lstat(journalPath)).mode) & 0o077), 0);
});

test('existing Oracle journal is authoritative for exact binding recovery and is never rewritten', async t => {
  const fixture = await fakeOracleFixture(t);
  const slug = 'oracle-existing-journal-exact-01';
  const count = path.join(fixture.home, 'existing-journal-exact-count.txt');
  await fixture.configure({ mode: 'success', count });
  const seeded = await writeExistingOracleJournal(fixture.home, slug, { profile: 'code' });

  const result = await runOracleModelProfile({
    profile: 'code',
    repo: oracleRepoRoot,
    prompt: 'must recover existing journal',
    slug,
    repoMcpPreattachedTab: true,
    browserTab: 'tab-test-01',
    oraclePath: fixture.executable,
    homeDir: fixture.home,
    environment: fakeEnvironment(fixture.home)
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.slug, slug);
    assert.equal(result.profile, 'code');
    assert.equal(result.requested_model, 'gpt-5.6-sol');
    assert.equal(result.requested_effort, 'high');
    assert.equal(result.recovery_reason, 'existing-run-journal');
    assert.equal(result.prompt_submitted, null);
  }
  assert.equal(await readFile(seeded.journalPath, 'utf8'), seeded.serialized);
  await assert.rejects(readFile(count, 'utf8'), /ENOENT/);
});

test('same Oracle slug with a different profile fails closed using the existing journal binding', async t => {
  const fixture = await fakeOracleFixture(t);
  const slug = 'oracle-journal-profile-mismatch-01';
  const count = path.join(fixture.home, 'journal-profile-mismatch-count.txt');
  await fixture.configure({ mode: 'success', count });
  const seeded = await writeExistingOracleJournal(fixture.home, slug, { profile: 'review-critical' });

  const result = await runOracleModelProfile({
    profile: 'code',
    repo: oracleRepoRoot,
    prompt: 'must not reuse mismatched slug',
    slug,
    repoMcpPreattachedTab: true,
    browserTab: 'tab-test-01',
    oraclePath: fixture.executable,
    homeDir: fixture.home,
    environment: fakeEnvironment(fixture.home)
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.slug, slug);
    assert.equal(result.profile, 'review-critical');
    assert.equal(result.requested_model, 'gpt-5-pro');
    assert.equal(result.requested_effort, 'pro');
    assert.equal(result.recovery_reason, 'existing-run-journal-binding-mismatch');
    assert.equal(result.prompt_submitted, null);
  }
  assert.equal(await readFile(seeded.journalPath, 'utf8'), seeded.serialized);
  await assert.rejects(readFile(count, 'utf8'), /ENOENT/);
});

test('same Oracle slug with a different repository binding fails closed without submission or overwrite', async t => {
  const fixture = await fakeOracleFixture(t);
  const slug = 'oracle-journal-repo-mismatch-01';
  const count = path.join(fixture.home, 'journal-repo-mismatch-count.txt');
  await fixture.configure({ mode: 'success', count });
  const seeded = await writeExistingOracleJournal(fixture.home, slug, {
    profile: 'code',
    repositoryRoot: '/different/repository'
  });

  const result = await runOracleModelProfile({
    profile: 'code',
    repo: oracleRepoRoot,
    prompt: 'must not cross repository binding',
    slug,
    repoMcpPreattachedTab: true,
    browserTab: 'tab-test-01',
    oraclePath: fixture.executable,
    homeDir: fixture.home,
    environment: fakeEnvironment(fixture.home)
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.slug, slug);
    assert.equal(result.profile, 'code');
    assert.equal(result.requested_model, 'gpt-5.6-sol');
    assert.equal(result.requested_effort, 'high');
    assert.equal(result.recovery_reason, 'existing-run-journal-binding-mismatch');
    assert.equal(result.prompt_submitted, null);
  }
  assert.equal(await readFile(seeded.journalPath, 'utf8'), seeded.serialized);
  await assert.rejects(readFile(count, 'utf8'), /ENOENT/);
});

test('unsafe or malformed existing Oracle journals are recovery-only and never submitted or repaired', async t => {
  const cases = [
    { name: 'malformed', options: { malformed: true } },
    { name: 'unsafe-permissions', options: { unsafePermissions: true } },
    { name: 'symlinked', options: { symlinked: true } }
  ] as const;

  for (const [index, journalCase] of cases.entries()) {
    const fixture = await fakeOracleFixture(t);
    const slug = `oracle-journal-unsafe-${index + 10}`;
    const count = path.join(fixture.home, `journal-unsafe-count-${index}.txt`);
    await fixture.configure({ mode: 'success', count });
    const seeded = await writeExistingOracleJournal(fixture.home, slug, journalCase.options);
    const before = await lstat(seeded.journalPath);
    const beforeText = journalCase.name === 'symlinked' ? undefined : await readFile(seeded.journalPath, 'utf8');

    const result = await runOracleModelProfile({
      profile: 'code',
      repo: oracleRepoRoot,
      prompt: 'must not trust unsafe journal',
      slug,
      repoMcpPreattachedTab: true,
      browserTab: 'tab-test-01',
      oraclePath: fixture.executable,
      homeDir: fixture.home,
      environment: fakeEnvironment(fixture.home)
    });

    assert.equal(result.ok, false, journalCase.name);
    if (!result.ok) {
      assert.equal(result.slug, slug, journalCase.name);
      assert.equal(result.recovery_reason, 'existing-run-journal-unverifiable', journalCase.name);
      assert.equal(result.prompt_submitted, null, journalCase.name);
    }
    const after = await lstat(seeded.journalPath);
    assert.equal(after.isSymbolicLink(), before.isSymbolicLink(), journalCase.name);
    assert.equal(Number(after.mode) & 0o777, Number(before.mode) & 0o777, journalCase.name);
    if (beforeText !== undefined) assert.equal(await readFile(seeded.journalPath, 'utf8'), beforeText, journalCase.name);
    await assert.rejects(readFile(count, 'utf8'), /ENOENT/, journalCase.name);
  }
});

test('generated Oracle slug requires a pre-launch reservation surface', async t => {
  const fixture = await fakeOracleFixture(t);
  const count = path.join(fixture.home, 'unsurfaced-generated-count.txt');
  await fixture.configure({ mode: 'success', count });
  await assert.rejects(
    runOracleModelProfile({
      profile: 'code',
      repo: oracleRepoRoot,
      prompt: 'must not launch without surfacing slug',
      repoMcpPreattachedTab: true,
      browserTab: 'tab-test-01',
      oraclePath: fixture.executable,
      homeDir: fixture.home,
      environment: fakeEnvironment(fixture.home)
    }),
    error => error instanceof ModelPolicyError && error.code === 'ORACLE_RESERVATION_SURFACE_REQUIRED'
  );
  await assert.rejects(readFile(count, 'utf8'), /ENOENT/);
});

test('atomic slug reservation permits only one concurrent same-slug Oracle submission', async t => {
  const fixture = await fakeOracleFixture(t);
  const count = path.join(fixture.home, 'concurrent-count.txt');
  await fixture.configure({ mode: 'success', count });
  const slug = 'oracle-concurrent-01';
  const options = {
    profile: 'code' as const,
    repo: oracleRepoRoot,
    prompt: 'single submission only',
    slug,
    repoMcpPreattachedTab: true as const,
    browserTab: 'tab-test-01',
    oraclePath: fixture.executable,
    homeDir: fixture.home,
    environment: fakeEnvironment(fixture.home)
  };
  const [a, b] = await Promise.all([
    runOracleModelProfile(options),
    runOracleModelProfile(options)
  ]);
  assert.equal([a, b].filter(result => result.ok).length, 1);
  const recovery = [a, b].find(result => !result.ok);
  assert.ok(recovery && !recovery.ok);
  if (recovery && !recovery.ok) {
    assert.equal(recovery.slug, slug);
    assert.equal(recovery.recovery_reason, 'existing-run-journal');
    assert.equal(recovery.prompt_submitted, null);
  }
  assert.equal(await readFile(count, 'utf8'), '1');
});

test('interrupted Oracle child keeps the journal and returns same-slug recovery without retry', async t => {
  const fixture = await fakeOracleFixture(t);
  const count = path.join(fixture.home, 'interrupted-count.txt');
  await fixture.configure({ mode: 'interrupted-after-spawn', count });
  const slug = 'oracle-interrupted-01';
  const result = await runOracleModelProfile({
    profile: 'review',
    repo: oracleRepoRoot,
    prompt: 'interrupted review',
    slug,
    repoMcpPreattachedTab: true,
    browserTab: 'tab-test-01',
    oraclePath: fixture.executable,
    homeDir: fixture.home,
    environment: fakeEnvironment(fixture.home)
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.slug, slug);
    assert.equal(result.prompt_submitted, true);
    assert.equal(result.recovery_reason, 'submitted-run-not-cleanly-completed');
  }
  assert.equal(await readFile(count, 'utf8'), '1');
  const journalPath = path.join(await realpath(fixture.home), '.repo-mcp-oracle-runs', slug + '.json');
  assert.match(await readFile(journalPath, 'utf8'), /oracle-run-journal-v1/);
});

test('existing Oracle session is recovery-only and is never resubmitted automatically', async t => {
  const fixture = await fakeOracleFixture(t);
  const slug = 'oracle-existing-01';
  const session = path.join(fixture.home, '.oracle', 'sessions', slug);
  await mkdir(session, { recursive: true, mode: 0o700 });
  await chmod(path.join(fixture.home, '.oracle'), 0o700);
  await chmod(path.join(fixture.home, '.oracle', 'sessions'), 0o700);
  await chmod(session, 0o700);
  const count = path.join(fixture.home, 'existing-count.txt');
  await fixture.configure({ mode: 'success', count });
  const result = await runOracleModelProfile({
    profile: 'brainstorm',
    repo: oracleRepoRoot,
    prompt: 'brainstorm task',
    slug,
    repoMcpPreattachedTab: true,
    browserTab: 'tab-test-01',
    oraclePath: fixture.executable,
    homeDir: fixture.home,
    environment: fakeEnvironment(fixture.home)
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.recovery_reason, 'existing-session');
    assert.equal(result.slug, slug);
  }
  await assert.rejects(readFile(count, 'utf8'), /ENOENT/);
});

test('Oracle adapter requires acknowledgement plus a conservative browser-tab reference and never treats it as plugin proof', async t => {
  const fixture = await fakeOracleFixture(t);
  await fixture.configure({ mode: 'success' });
  await assert.rejects(
    runOracleModelProfile({
      profile: 'code',
      repo: oracleRepoRoot,
      prompt: 'code task',
      repoMcpPreattachedTab: false,
      browserTab: 'tab-test-01',
      oraclePath: fixture.executable,
      homeDir: fixture.home,
      environment: fakeEnvironment(fixture.home)
    }),
    error => error instanceof ModelPolicyError && error.code === 'REPO_MCP_PREATTACHED_REQUIRED'
  );
  for (const browserTab of ['', 'tab with spaces', '../tab', 'https://chatgpt.com/c/unsafe']) {
    await assert.rejects(
      runOracleModelProfile({
        profile: 'code',
        repo: oracleRepoRoot,
        prompt: 'code task',
        repoMcpPreattachedTab: true,
        browserTab,
        oraclePath: fixture.executable,
        homeDir: fixture.home,
        environment: fakeEnvironment(fixture.home)
      }),
      error => error instanceof ModelPolicyError && error.code === 'INVALID_ORACLE_BROWSER_TAB'
    );
  }
});

test('prompt-file reader is bounded, non-symlink, regular-file only, and rejects FIFO/device inputs', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-prompt-file-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const valid = path.join(base, 'valid.txt');
  await writeFile(valid, 'bounded prompt');
  assert.equal(await readOraclePromptFile(valid), 'bounded prompt');

  const oversized = path.join(base, 'oversized.txt');
  await writeFile(oversized, Buffer.alloc(1024 * 1024 + 1, 0x61));
  await expectCode(readOraclePromptFile(oversized), 'ORACLE_PROMPT_FILE_UNSAFE');

  const linked = path.join(base, 'linked.txt');
  await symlink(valid, linked);
  await expectCode(readOraclePromptFile(linked), 'ORACLE_PROMPT_FILE_UNSAFE');

  await expectCode(readOraclePromptFile(base), 'ORACLE_PROMPT_FILE_UNSAFE');
  if (process.platform !== 'win32') {
    await expectCode(readOraclePromptFile('/dev/null'), 'ORACLE_PROMPT_FILE_UNSAFE');
    const fifo = path.join(base, 'prompt.fifo');
    const mkfifo = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
    assert.equal(mkfifo.status, 0, mkfifo.stderr);
    await expectCode(readOraclePromptFile(fifo), 'ORACLE_PROMPT_FILE_UNSAFE');
  }
});

test('CLI prompt-file path uses the bounded safe reader before any Oracle launch', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'repo-mcp-prompt-cli-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const target = path.join(base, 'prompt.txt');
  const linked = path.join(base, 'prompt-link.txt');
  await writeFile(target, 'never launch');
  await symlink(target, linked);
  const processResult = spawnSync(process.execPath, [
    '--import', 'tsx', path.join(projectRoot, 'scripts/model-policy.ts'),
    'run', '--profile', 'code', '--repo', oracleRepoRoot,
    '--prompt-file', linked,
    '--repo-mcp-preattached-tab',
    '--browser-tab', 'tab-test-01'
  ], { cwd: projectRoot, encoding: 'utf8' });
  assert.notEqual(processResult.status, 0);
  const parsed = JSON.parse(processResult.stdout) as { error: { code: string } };
  assert.equal(parsed.error.code, 'ORACLE_PROMPT_FILE_UNSAFE');
});

test('package exposes the production model-policy adapter entry point', async () => {
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  assert.equal(packageJson.scripts?.['model-policy'], 'tsx scripts/model-policy.ts');
});

test('Oracle executable resolution uses PATH or an explicit path and rejects unsafe files', async t => {
  const fixture = await fakeOracleFixture(t);
  const link = path.join(fixture.home, 'oracle');
  await symlink(fixture.executable, link);
  assert.equal(await resolveOracleExecutable(undefined, fixture.home), await realpath(fixture.executable));
  assert.equal(await resolveOracleExecutable(fixture.executable, ''), await realpath(fixture.executable));
  await assert.rejects(resolveOracleExecutable('oracle', ''), /absolute/i);
  await assert.rejects(resolveOracleExecutable(undefined, '.:'), /not found/i);
  await chmod(fixture.executable, 0o777);
  await assert.rejects(resolveOracleExecutable(fixture.executable, ''), /regular file|write access/i);
});

test('public Oracle CLI supports PATH discovery and explicit executable override with preflight', async t => {
  const fixture = await fakeOracleFixture(t);
  await fixture.configure({ mode: 'success' });
  await symlink(fixture.executable, path.join(fixture.home, 'oracle'));
  for (const [index, explicit] of [false, true].entries()) {
    const result = spawnSync(process.execPath, [
      '--import', 'tsx', path.join(projectRoot, 'scripts/model-policy.ts'), 'run',
      '--profile', 'code', '--repo', oracleRepoRoot, '--prompt', 'portable fake run',
      '--repo-mcp-preattached-tab', '--browser-tab', 'tab-test-01', '--slug', 'oracle-portable-cli-' + index,
      ...(explicit ? ['--oracle-path', fixture.executable] : [])
    ], {
      cwd: projectRoot, encoding: 'utf8', timeout: 15000,
      // NODE_OPTIONS affects this test's wrapper process before the CLI can
      // sanitize the environment passed to Oracle, so keep it empty here.
      env: { ...fakeEnvironment(fixture.home), NODE_OPTIONS: '', PATH: fixture.home + path.delimiter + (process.env.PATH ?? '') }
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
  }
  await fixture.configure({ mode: 'bad-version' });
  const failed = spawnSync(process.execPath, [
    '--import', 'tsx', path.join(projectRoot, 'scripts/model-policy.ts'), 'run',
    '--profile', 'code', '--repo', oracleRepoRoot, '--prompt', 'must not submit',
    '--repo-mcp-preattached-tab', '--browser-tab', 'tab-test-01',
    '--oracle-path', fixture.executable, '--slug', 'oracle-portable-bad-version'
  ], { cwd: projectRoot, encoding: 'utf8', timeout: 15000, env: fakeEnvironment(fixture.home, { NODE_OPTIONS: '' }) });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stdout, /ORACLE.*COMPAT|version/i);
});
