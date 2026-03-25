#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const files = [
  path.join(repoRoot, 'src/ops-api-worker.mjs'),
  path.resolve(repoRoot, '../oak-chain-dashboard-eds/scripts/ops-api-mock.mjs'),
];

const checks = [
  {
    name: 'raw Aeron fetch',
    regex: /upstreamGet(?:FromBase|Unwrapped|Snapshot)?\(\s*['"]\/v1\/aeron\//g,
  },
  {
    name: 'raw health fetch',
    regex: /upstreamGet(?:FromBase|Unwrapped|Snapshot)?\(\s*['"]\/health(?:\/deep)?(?:[?'"]|$)/g,
  },
  {
    name: 'raw explorer/api fetch',
    regex: /upstreamGet(?:FromBase|Unwrapped|Snapshot)?\(\s*['"]\/api\//g,
  },
];

const violations = [];

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const lines = source.split('\n');

  checks.forEach(({ name, regex }) => {
    let match;
    while ((match = regex.exec(source)) !== null) {
      const line = source.slice(0, match.index).split('\n').length;
      violations.push(`${path.basename(file)}:${line} ${name}`);
    }
    regex.lastIndex = 0;
  });
}

if (violations.length > 0) {
  console.error('Governed source check failed:');
  violations.forEach((violation) => console.error(` - ${violation}`));
  process.exit(1);
}

console.log('Governed source check passed.');
