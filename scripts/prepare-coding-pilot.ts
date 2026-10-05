import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture, buggySource } from '../src/fixture.js';
import { defaultPolicy, execute } from '../src/repo.js';

const root = path.resolve('.trial/coding-pilot');
await mkdir(path.dirname(root), {recursive:true});
await prepareFixture(root); // refuses an existing directory
await writeFile(path.join(root,'src/clamp.js'), buggySource.replace('max - 1','max'));
await writeFile(path.join(root,'README.md'), 'File creation pilot: implement exported normalizeRange(value, min, max) in src/normalize-range.js. Return (clamp(value,min,max)-min)/(max-min). Reject non-finite inputs and min >= max with RangeError. Add tests in test/normalize-range.test.js and extend test/clamp.test.js with fractional and negative bounds. Preserve existing assertions.\n');
await writeFile(path.join(root,'AGENTS.md'), 'Dedicated disposable coding pilot. Only this MCP server may write while a task runs. Read README.md for the task. You may create src/normalize-range.js and test/normalize-range.test.js, edit those files and test/clamp.test.js, and inspect src/clamp.js. Preserve the original six clamp tests. Run baseline tests, add failing tests, implement, rerun all suites, inspect the entire diff and report test changes. No package changes, commits or installs.\n');
for (const args of [['add','--','.'],['-c','user.name=MCP Trial','-c','user.email=trial@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-m','Prepare green file creation pilot']]) {
  const result = await execute('/usr/bin/git', args, root);
  if (result.exit_code !== 0) throw new Error('Pilot baseline creation failed.');
}
const added = ['src/normalize-range.js','test/normalize-range.test.js'];
const policy = {files:[...defaultPolicy.files,...added], editable:['test/clamp.test.js',...added], creatable:added, tests:['test/clamp.test.js','test/normalize-range.test.js']};
await writeFile(path.resolve('.trial/coding-pilot-policy.json'), JSON.stringify(policy,null,2)+'\n');
console.log('Prepared '+root+'; original six tests pass. New feature files are absent and ready for ChatGPT.');
