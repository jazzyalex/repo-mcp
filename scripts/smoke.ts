import { mkdir, writeFile } from 'node:fs/promises';
import { exercise } from './exercise.js';
const results = [];
for (const modern of [true, false]) results.push(await exercise(modern));
await mkdir('evidence', { recursive: true });
await writeFile('evidence/local-smoke.json', JSON.stringify({ recorded_at: new Date().toISOString(), results }, null, 2) + '\n');
console.log(JSON.stringify(results.map(({ calls, ...summary }) => summary), null, 2));
