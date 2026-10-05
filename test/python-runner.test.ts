import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm, realpath, readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {RepoWorkspace, execute} from '../src/repo.js';

test('Python pilot runs pytest while denying user files, outside writes, networking and children', {skip: process.platform !== 'darwin' || !existsSync('.trial/agent-sessions-pilot-policy.json')}, async t => {
  const config = JSON.parse(await readFile('.trial/agent-sessions-pilot-policy.json','utf8'));
  if (!existsSync(config.runner.executable) || !existsSync(config.runner.dependencies)) {
    t.skip('optional disposable pilot runtime is no longer installed');
    return;
  }
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(),'repo-mcp-python-test-')));
  const root = path.join(base,'repo'); await mkdir(root);
  const secret = path.join(base,'excluded.txt'); await writeFile(secret,'SYNTHETIC_SECRET');
  const code = `import errno, os, socket, subprocess
from pathlib import Path
import pytest

def denied(fn):
    with pytest.raises(OSError) as error:
        fn()
    assert error.value.errno in (errno.EPERM, errno.EACCES)

def test_boundaries():
    denied(lambda: Path(${JSON.stringify(secret)}).read_text())
    denied(lambda: Path(${JSON.stringify(secret)}).write_text('overwrite'))
    denied(lambda: Path(${JSON.stringify(config.runner.dependencies + '/tamper.py')}).write_text('overwrite'))
    denied(lambda: subprocess.run(['/bin/echo','unexpected'], check=True))
    with socket.socket() as sock:
        denied(lambda: sock.connect(('127.0.0.1', 9)))
    assert 'HOME' not in os.environ
    assert 'OPENAI_API_KEY' not in os.environ
    Path('allowed-output.txt').write_text('local')
    assert Path('allowed-output.txt').read_text() == 'local'
`;
  await writeFile(path.join(root,'AGENTS.md'),'Runner boundary test.');
  await writeFile(path.join(root,'test_boundary.py'), code);
  try {
    for (const args of [['init','-q'],['add','--','.'],['-c','user.name=Test','-c','user.email=test@localhost','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-qm','Fixture']]) assert.equal((await execute('/usr/bin/git',args,root)).exit_code,0);
    const repo=await RepoWorkspace.create(root,{files:['AGENTS.md','test_boundary.py'],editable:[],tests:['test_boundary.py'],runner:config.runner});
    const result=await repo.test();
    assert.equal(result.exit_code,0,result.stdout+result.stderr);
    assert.match(result.stdout,/1 passed/);
    assert.equal(await readFile(secret,'utf8'),'SYNTHETIC_SECRET');
    assert.equal(existsSync(path.join(root,'allowed-output.txt')),false);
  } finally {await rm(base,{recursive:true,force:true});}
});
