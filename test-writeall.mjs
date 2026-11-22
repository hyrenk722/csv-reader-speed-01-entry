// Driver test for writeAll in main.ts (Ponytail audit round 13, finding #1):
// one case whose answer JSON is over 16MB, with a multi-byte character
// straddling the 16MB buffer edge. The output file must be byte-identical to
// JSON.stringify of the direct run() answers, and must JSON.parse.
// The field is built so a 4-byte char starts at byte 16,777,213 of the
// answers file and ends past byte 16,777,216: the old `n === length` check
// missed exactly this cut-off and silently dropped the tail (see
// PONYTAIL-AUDIT-ROUND13.md). Run after any edit to main.ts.
// Usage: node test-writeall.mjs [driver-path]  (default ./main.ts)
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from './solve.js';

const driver = process.argv[2] ?? fileURLToPath(new URL('./main.ts', import.meta.url));

const field = 'a'.repeat(16770001) + 'é€😀'.repeat(4000) + 'a'.repeat(1000);
const cases = [
  { id: 'small', input: { text: 'a,b\n1,2\n', header: true } },
  { id: 'big', input: { text: field, header: false } },
];

const dir = mkdtempSync(join(tmpdir(), 'writeall-test-'));
const inputDir = join(dir, 'input');
const outputDir = join(dir, 'output');
mkdirSync(inputDir);
mkdirSync(outputDir);
writeFileSync(join(inputDir, 'cases.json'), JSON.stringify(cases));
const expected = JSON.stringify(cases.map((c) => run(c.input)));

const res = spawnSync(process.execPath, [driver], {
  env: { ...process.env, MAKEFUN_INPUT_DIR: inputDir, MAKEFUN_OUTPUT_DIR: outputDir },
  encoding: 'utf8',
});
if (res.status !== 0) {
  console.error(`FAIL: driver exited ${res.status}\n${res.stderr}`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}
const out = readFileSync(join(outputDir, 'answers.json'));
try {
  JSON.parse(out.toString('utf8'));
} catch (e) {
  console.error(`FAIL: output does not parse: ${e.message} (bytes ${out.length}, expected ${Buffer.byteLength(expected)})`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}
if (!out.equals(Buffer.from(expected, 'utf8'))) {
  console.error(`FAIL: output differs (bytes ${out.length}, expected ${Buffer.byteLength(expected)})`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}
console.log(`PASS: output byte-identical to JSON.stringify of direct answers (${out.length} bytes, >16MB straddle case included)`);
rmSync(dir, { recursive: true, force: true });
