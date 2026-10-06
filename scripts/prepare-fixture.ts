import { mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { prepareFixture } from '../src/fixture.js';
const { values } = parseArgs({ options: { root: { type: 'string' } }, allowPositionals: false });
const root = path.resolve(values.root ?? '.trial/repo');
await mkdir(path.dirname(root), { recursive: true });
await prepareFixture(root);
console.log(`Disposable repository prepared at ${root}`);
