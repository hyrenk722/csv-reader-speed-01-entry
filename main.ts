// The driver the harness runs: `node /bot/main.ts`. It reads every case from /input/cases.json (a
// JSON array of {id, input}), answers each one alone with run() from solve.js, and writes
// /output/answers.json: a JSON array of the answers, one per case and in the cases' order.
// Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.
//
// Answers are written one case at a time instead of stringifying the whole array at once: the
// full answers graph plus its 12 MB JSON string kept alive together cost repeated full GCs under
// --no-incremental-marking, and each case's answer and input are dropped as soon as they are
// written, so the live set stays one case small. The bytes written are identical to
// JSON.stringify of the whole array: '[' + per-case JSON + ',' ... + ']'.
import { readFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its work runs under it
// (the house baseline runs with --no-incremental-marking, and an entry may tune V8's flags too).
setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Write the whole string at the current file position, looping over short writes. */
function writeAll(fd: number, s: string): void {
  // Whole-string write: no per-case Buffer alloc+copy (6 cases x ~2 MB each).
  // Regular files write fully in practice; on a short write finish the rest
  // through a buffer (same UTF-8 bytes, byte offset n).
  const n = writeSync(fd, s);
  if (n < Buffer.byteLength(s)) {
    const buf = Buffer.from(s, 'utf8');
    let off = n;
    while (off < buf.length) {
      const m = writeSync(fd, buf, off, buf.length - off);
      if (m <= 0) throw new Error('short write to answers.json');
      off += m;
    }
  }
}

const cases: ({ id: string; input: unknown } | null)[] = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8'));
const fd = openSync(join(OUTPUT_DIR, 'answers.json'), 'w');
try {
  writeAll(fd, '[');
  for (let i = 0; i < cases.length; i++) {
    const answer = run(cases[i]!.input);
    cases[i] = null;
    if (i) writeAll(fd, ',');
    writeAll(fd, JSON.stringify(answer) as string);
  }
  writeAll(fd, ']');
} finally {
  closeSync(fd);
}
