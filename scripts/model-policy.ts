import { readRegularFile, BOUNDED_JSON_MAX_BYTES } from '../src/bounded-file.js';
import { parseArgs } from 'node:util';
import {
  ModelPolicyError,
  readOraclePromptFile,
  resolveModelProfile,
  runOracleModelProfile,
  verifyModelSelection,
  type ChatSurface,
  type ModelProfile
} from '../src/model-policy.js';

function output(value: unknown) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function fail(error: unknown) {
  if (error instanceof ModelPolicyError) {
    output({ ok: false, error: { code: error.code, message: error.message } });
  } else {
    output({ ok: false, error: { code: 'CLI_ERROR', message: error instanceof Error ? error.message : 'Model-policy command failed.' } });
  }
  process.exitCode = 1;
}

async function readJson(path: string, kind: string) {
  try {
    return JSON.parse(await readRegularFile(path, BOUNDED_JSON_MAX_BYTES, kind + ' file')) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new ModelPolicyError('INVALID_JSON', kind + ' file must contain valid JSON.');
    throw new ModelPolicyError('JSON_FILE_UNSAFE', error instanceof Error ? error.message : kind + ' file cannot be read safely.');
  }
}

function unwrapResolvedContract(value: unknown) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if (object.ok === true && object.contract !== undefined) return object.contract;
  }
  return value;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (command === 'resolve') {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: false,
      strict: true,
      options: {
        profile: { type: 'string' },
        surface: { type: 'string' },
        'conversation-id': { type: 'string' },
        'session-id': { type: 'string' }
      }
    });
    if (positionals.length !== 0 || !values.profile || !values.surface) {
      throw new ModelPolicyError('CLI_USAGE', 'resolve requires --profile and --surface.');
    }
    const contract = await resolveModelProfile(
      values.profile as ModelProfile,
      values.surface as ChatSurface,
      {
        conversationId: values['conversation-id'],
        sessionId: values['session-id']
      }
    );
    output({ ok: true, contract });
    return;
  }

  if (command === 'verify') {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: false,
      strict: true,
      options: {
        'contract-file': { type: 'string' },
        'evidence-file': { type: 'string' }
      }
    });
    if (positionals.length !== 0 || !values['contract-file'] || !values['evidence-file']) {
      throw new ModelPolicyError('CLI_USAGE', 'verify requires --contract-file and --evidence-file.');
    }
    const contract = unwrapResolvedContract(await readJson(values['contract-file'], 'Contract'));
    const evidence = await readJson(values['evidence-file'], 'Evidence');
    output(await verifyModelSelection(contract, evidence));
    return;
  }

  if (command === 'run') {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: false,
      strict: true,
      options: {
        backend: { type: 'string' },
        profile: { type: 'string' },
        repo: { type: 'string' },
        prompt: { type: 'string' },
        'prompt-file': { type: 'string' },
        file: { type: 'string', multiple: true },
        slug: { type: 'string' },
        'browser-tab': { type: 'string' },
        'oracle-path': { type: 'string' },
        'repo-mcp-preattached-tab': { type: 'boolean' }
      }
    });
    if (positionals.length !== 0 || !values.profile || !values.repo) {
      throw new ModelPolicyError('CLI_USAGE', 'run requires --profile and --repo.');
    }
    if (values.backend === undefined) {
      throw new ModelPolicyError('BACKEND_REQUIRED', 'run requires an explicit --backend. Use --backend oracle only for an explicitly requested legacy Oracle run.');
    }
    if (values.backend !== 'oracle') {
      throw new ModelPolicyError('UNSUPPORTED_BACKEND', 'Unsupported run backend. This release exposes only the optional legacy oracle backend; host-native adapters use resolve and verify.');
    }
    if ((values.prompt === undefined) === (values['prompt-file'] === undefined)) {
      throw new ModelPolicyError('CLI_USAGE', 'run requires exactly one of --prompt or --prompt-file.');
    }
    if (values['repo-mcp-preattached-tab'] !== true || !values['browser-tab']) {
      throw new ModelPolicyError('CLI_USAGE', 'run requires --repo-mcp-preattached-tab and --browser-tab; the tab reference identifies the intended existing tab but does not prove Repo MCP is attached.');
    }
    const prompt = values.prompt ?? await readOraclePromptFile(values['prompt-file']!);
    const result = await runOracleModelProfile({
      profile: values.profile as ModelProfile,
      repo: values.repo,
      prompt,
      files: values.file,
      slug: values.slug,
      repoMcpPreattachedTab: true,
      browserTab: values['browser-tab'],
      oraclePath: values['oracle-path'],
      onReserved: reservation => {
        process.stderr.write(JSON.stringify({ event: 'oracle-run-reserved', ...reservation }) + '\n');
      }
    });
    output(result);
    if (!result.ok) process.exitCode = 2;
    return;
  }

  throw new ModelPolicyError('CLI_USAGE', 'Command must be resolve, verify, or run. The run command also requires an explicit backend.');
}

main().catch(fail);
