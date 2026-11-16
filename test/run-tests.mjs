#!/usr/bin/env node
// Test runner. Imports every *.test.mjs file next to this one and executes the
// registered tests through the shared harness.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const files = fs
  .readdirSync(here)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();

for (const file of files) {
  await import(pathToFileURL(path.join(here, file)).href);
}

const ok = await run();
process.exitCode = ok ? 0 : 1;
