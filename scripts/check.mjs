import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let count = 0;
async function check(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await check(file);
    else if (file.endsWith('.mjs')) { execFileSync(process.execPath, ['--check', file]); count++; }
  }
}
for (const directory of ['src', 'bin', 'scripts', 'tests']) await check(directory);
console.log(`Syntax checks passed for ${count} modules.`);
