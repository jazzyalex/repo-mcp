import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture } from '../src/fixture.js';
await mkdir('.trial', { recursive: true });
const root = path.resolve('.trial/repo');
await prepareFixture(root);
console.log(`Disposable repository prepared at ${root}`);
