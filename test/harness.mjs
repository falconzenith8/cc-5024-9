// Test harness: a tiny assertion runner (no dependencies).

import assert from 'node:assert/strict';

const tests = [];
let currentSuite = '';

export function suite(name) {
  currentSuite = name;
}

export function test(name, fn) {
  tests.push({ name: `${currentSuite} :: ${name}`, fn });
}

export async function run() {
  let passed = 0;
  const failures = [];
  for (const t of tests) {
    const started = process.hrtime.bigint();
    try {
      await t.fn();
      passed++;
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      console.log(`ok   ${t.name}  (${ms.toFixed(0)} ms)`);
    } catch (err) {
      failures.push({ name: t.name, err });
      console.log(`FAIL ${t.name}\n     ${err.message.split('\n').join('\n     ')}`);
    }
  }
  console.log(`\n${passed}/${tests.length} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.error(`\n--- ${f.name}\n${f.err.stack}`);
    process.exitCode = 1;
  }
  return failures.length === 0;
}

export { assert };
