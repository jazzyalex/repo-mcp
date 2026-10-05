import path from 'node:path';
import { realpath, writeFile } from 'node:fs/promises';

export type PythonRunner = { kind: 'python-pytest'; executable: string; dependencies: string };

// Operator-owned configuration, never tool arguments. Python code receives only
// the approved source snapshot plus a separate copied pytest dependency tree.
export async function pythonCommand(snapshot: string, suites: string[], runner: PythonRunner) {
  if (process.platform !== 'darwin') throw new Error('Python pilot requires macOS sandbox-exec.');
  const executable = await realpath(runner.executable);
  const dependencies = await realpath(runner.dependencies);
  if (!path.isAbsolute(runner.executable) || !path.isAbsolute(runner.dependencies) || dependencies === snapshot) throw new Error('Invalid Python runtime paths.');
  const quote = (s: string) => JSON.stringify(s);
  const except = `(require-not (subpath ${quote(snapshot)})) (require-not (subpath ${quote(dependencies)}))`;
  const blocked = ['/Users', '/Volumes', '/private/var', '/private/tmp', '/tmp', '/var'];
  const profile = `(version 1)
(allow default)
(deny network*)
(deny process-fork)
(deny file-write* (require-all (require-not (subpath ${quote(snapshot)})) (require-not (literal "/dev/null"))))
${blocked.map(root => `(deny file-read-data (require-all (subpath ${quote(root)}) ${except}))`).join('\n')}
`;
  const profilePath = path.join(snapshot, '.python-pilot.sb');
  await writeFile(profilePath, profile, {flag:'wx', mode:0o600});
  const bootstrap = 'import sys; sys.path.insert(0, sys.argv.pop(1)); import pytest; raise SystemExit(pytest.main(sys.argv[1:]))';
  return {
    executable: '/usr/bin/sandbox-exec',
    args: ['-f', profilePath, executable, '-I', '-S', '-B', '-c', bootstrap, dependencies, '-q', '-p', 'no:cacheprovider', ...suites],
    env: {PYTEST_DISABLE_PLUGIN_AUTOLOAD:'1', TMPDIR:snapshot},
    label: 'macOS sandbox-exec Python isolated pytest (approved snapshot; plugin autoload disabled)'
  };
}
