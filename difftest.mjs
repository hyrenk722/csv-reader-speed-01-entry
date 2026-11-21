// difftest.mjs — self-contained differential test for this repo.
//
// Compares solve.js's run() against the reference reader, csv-reader 1.0.0,
// copied in below verbatim from the competition kit's vendor/csv-reader/
// (make.fun's own code; its LICENSE and NOTICE are summarised in the copied
// header). No kit path, no install, no network: `node difftest.mjs`.
// Exit 0 when every case agrees, 1 otherwise.
//
// Coverage: every string of length 0..6 over {a, comma, quote, CR, LF} in both
// header modes, the hand-built edge list, two seeded fuzzers, and the full
// code-unit sweep below (every UTF-16 code unit 0..65535 embedded in an
// unquoted field and at a field start, in both header modes).

import { run as mine } from './solve.js';

// --- the reference reader, csv-reader 1.0.0 (copied verbatim) ---
// csv-reader 1.0.0, make.fun's own CSV reader: the reference program of csv-reader-speed-01. It reads a CSV text once,
// left to right, by a written broken-row policy, and answers {columns, rows, errors}: the header (or null), every other
// record as an array of strings at the first record's width, and a record of every broken thing it met.
//
// It is written to be plain and easy to check, not fast: one character at a time, each field built up a character at a
// time. Its loop follows d3-dsv 3.0.2's parseRows (ISC, Copyright 2013-2026 Mike Bostock; NOTICE): one token at a time,
// each token a field that ends at a comma, at a line break or at the end of the text. Its error records follow the idea
// of papaparse 5.7.1's errors array (MIT, Copyright (c) 2015 Matthew Holt; NOTICE). The policy is make.fun's own, and
// neither upstream reads a broken row as it does:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled, "" inside it one quote, and each CRLF
//     or lone CR inside it is read as LF; what follows its closing quote, up to the next comma or line break, is
//     appended to it as it stands (quote_junk, when the field ends); a quote that never closes is read as a literal
//     character and the text after it is read again as an unquoted field (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the records after it (every record when
//     header is false), each padded with "" (short_row, with fields: its count) or cut (long_row, with extra: the cut
//     fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts on (every LF, CRLF and lone CR inside a
//     quoted field counted), row its record's index in rows (null for the header), in the order met, a field's
//     quote_junk when the field ends and a record's short_row or long_row when the record ends.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the next.

/** How a field ended: at a comma (the record goes on), at a line break or at the end of the text (the record ends). */
const COMMA = 'comma';
const LINE_BREAK = 'line break';
const END = 'end';

/** The reading of one CSV input, {text, header}: {columns, rows, errors} (the header). */
export function readCsv(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text[0] === '\uFEFF') pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // The character at i, or '' past the end of the text.
  function at(i) {
    return i < text.length ? text[i] : '';
  }

  // Reads unquoted characters onto `value` up to the next comma or line break: a CR not followed by LF is dropped
  // (stray_cr). Returns the field and how it ended; `added` counts the characters kept.
  function readUnquoted(value) {
    let added = 0;
    while (pos < text.length) {
      const c = text[pos];
      if (c === ',') {
        pos += 1;
        return { value, ended: COMMA, added };
      }
      if (c === '\n') {
        pos += 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      if (c === '\r') {
        if (at(pos + 1) === '\n') {
          pos += 2;
          line += 1;
          return { value, ended: LINE_BREAK, added };
        }
        error('stray_cr');
        pos += 1;
        continue;
      }
      value += c;
      added += 1;
      pos += 1;
    }
    return { value, ended: END, added };
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    let closed = false;
    while (pos < text.length) {
      const c = text[pos];
      if (c === '"') {
        if (at(pos + 1) === '"') {
          value += '"';
          pos += 2;
          continue;
        }
        pos += 1;
        closed = true;
        break;
      }
      if (c === '\r') {
        // CRLF and a lone CR inside quotes are each one LF.
        value += '\n';
        line += 1;
        pos += at(pos + 1) === '\n' ? 2 : 1;
        continue;
      }
      if (c === '\n') line += 1;
      value += c;
      pos += 1;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      error('unterminated_quote');
      return readUnquoted('"');
    }
    if (pos >= text.length) return { value, ended: END };
    const c = text[pos];
    if (c === ',') {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === '\n') {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === '\r' && at(pos + 1) === '\n') {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    // What follows the closing quote is appended as it stands, up to the next comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) error('quote_junk');
    return junk;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < text.length) {
      if (text[pos] === '\n') {
        pos += 1;
        line += 1;
      } else if (text[pos] === '\r' && at(pos + 1) === '\n') {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= text.length) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let quoted;
    do {
      quoted = text[pos] === '"';
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

/** csv-reader 1.0.0's answer for one case's input. */
function oracle(input) {
  return readCsv(input);
}

// --- comparison harness ---
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

let total = 0;
let failed = 0;
function check(input, label) {
  total += 1;
  const a = canonical(mine(input));
  const b = canonical(oracle(input));
  if (a !== b) {
    failed += 1;
    console.log(`FAIL ${label}: input=${JSON.stringify(input).slice(0, 300)}`);
    console.log(`  mine  =${a.slice(0, 400)}`);
    console.log(`  oracle=${b.slice(0, 400)}`);
  }
}

// --- exhaustive: every string of length 0..6 over {a, comma, quote, CR, LF} x 2 header modes ---
const ALPHA = ['a', ',', '"', '\r', '\n'];
function exhaustive() {
  for (let len = 0; len <= 6; len++) {
    const idx = new Array(len).fill(0);
    for (;;) {
      const s = idx.map((i) => ALPHA[i]).join('');
      check({ text: s, header: true }, `exhaustive#${len}:${JSON.stringify(s)}:h`);
      check({ text: s, header: false }, `exhaustive#${len}:${JSON.stringify(s)}:n`);
      let p = len - 1;
      while (p >= 0) {
        idx[p] += 1;
        if (idx[p] < ALPHA.length) break;
        idx[p] = 0;
        p -= 1;
      }
      if (p < 0) break;
    }
  }
}
exhaustive();

// --- code-unit sweep: every UTF-16 code unit 0..65535, embedded in an unquoted
// field (mid-field, first and second field) and at a field start, and inside a
// quoted field (plain, next to CRs and LFs), x 2 header modes. This is the
// guard for the 65536-entry UCLASS table and for the readQuoted scan: a wrong
// class for any high character (e.g. U+2028, U+2029, U+FEFF, or a lone
// surrogate 0xD800-0xDFFF) would show up here as a mismatch against the
// oracle, where the exhaustive alphabet above cannot see it. ---
function codeUnitSweep() {
  for (let cu = 0; cu <= 0xffff; cu++) {
    const ch = String.fromCharCode(cu);
    const shapes = [
      `x${ch}y,z\n`,
      `${ch}y,z\n`,
      `x,${ch}y\n`,
      `"a${ch}b",c\n`,
      `"a${ch}\r${ch}b",c\n`,
      `"a${ch}\n${ch}b",c\n`,
    ];
    for (const s of shapes) {
      check({ text: s, header: true }, `sweep#${cu}:${JSON.stringify(s)}:h`);
      check({ text: s, header: false }, `sweep#${cu}:${JSON.stringify(s)}:n`);
    }
  }
}
codeUnitSweep();

// --- hand-written edge cases ---
const T = (text, header) => ({ text, header });
const edges = [
  T('', true), T('', false),
  T('\uFEFF', true), T('\uFEFF', false),
  T('\uFEFFa,b\n1,2\n', true), T('\uFEFFa,b\n1,2\n', false),
  T('a,b,c', true), T('a,b,c', false),
  T('a,b,c\n', true), T('a,b,c\n\n\n', true),
  T('\n\n\na,b\n1,2', true),
  T('\r\n\r\na,b\r\n1,2\r\n', true),
  T('\r', true), T('\r', false), T('\r\r\r', true), T('\r\n', true), T('\n', false),
  T('a\rb\n', false), T('a\rb\rc', false), T('\ra,b\n', true),
  T('a,b\r\n1,2\r3,4\n', false),
  T('""', true), T('""', false), T('""\n', true), T('"",x\n', false),
  T('"a"', false), T('"a""b"', false), T('"a"""', false), T('"a""', false),
  T('"a', false), T('"', false), T('"', true), T('"abc\ndef', false), T('"abc\ndef', true),
  T('"abc,def\nghi,jkl', false),
  T('"a"x,b\n', false), T('"a"xy"z,b\n', false), T('"a"\r,b\n', false), T('"a"\r\nb\n', false),
  T('"a"\rb\n', false), T('"a" \n', false),
  T('"x\ny",b\n', false), T('"x\r\ny",b\n', false), T('"x\ry",b\n', false), T('"x\r\r\ny",b\n', false),
  T('a,"b\nc",d\ne,f,g\n', false),
  T('a,b\n1\n2,3,4\n5,6\n', true), T('a,b\n1\n2,3,4\n5,6\n', false),
  T('a\n1,2\n', true), T('a,b,c\n1,2\n', true),
  T(',,,\n,,\n', false), T(',\n', false), T(',', false), T('a,', false), T(',a', false),
  T('a,b\n\r\n1,2\n', true), T('a,b\n\r1,2\n', true), T('a,b\n\r\r\n1,2\n', true),
  T('"mul\nti\nline",x\ny,z\n', true),
  T('h1,h2\n"unterm\nrest,of\nfile,here\n', true),
  T('h1,h2\n"unterm\nrest,of\nfile,here\n', false),
  T('x\n"a\rb\nc', false),
  T('"a\r\nb",c\r\nd,e\r\n', false),
  T('word,"phr, ase",note\n', false),
  T('a,b\n"x"junk,y\n', false), T('a,b\n"x"ju\rnk,y\n', false), T('a,b\n"x"\r,y\n', false),
  T('a,b\n"x"\r\r,y\n', false),
  T('pre"mid,post\n', false), T('a"b"c,d\n', false),
  T('   \n  ,  \n', false), T(' \n', false),
  T('a,b\r\n\r\n\r\n1,2', true),
  T('"q""q",z\n', false), T('"""",z\n', false), T('"""""",z\n', false),
  T('"a\n', false), T('"a\n"', false), T('"a\n""', false),
  T('x,y\n"a\nb', false), T('x,y\n"a\nb\n', false),
  T('é,東京\nß,Δ\n', false),
  T('a,b\n1,2', true), T('a,b\n1,2\n\n', true),
  T('\uFEFF\uFEFFa\n', false),
  T('a\r\nb\rc\nd\r', false),
  T('"tail', true), T('h\n"tail', true),
  T('a,b\nc,"d\ne",f\n', false),
  T('a,b\nc,"d\ne\nf,g\n', false),
];
edges.forEach((e, i) => check(e, `edge#${i}`));

// --- fuzzers: random CSV-ish texts from an adversarial alphabet (fixed seeds) ---
let seed = 123456789;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x80000000;
}
const pieces = ['a', 'bb', 'ccc', ',', '"', '""', '\n', '\r', '\r\n', ' ', 'x"y', '"q"', 'é', '', '1', 'a,b', '"m\nn"', '"u\rv"', '\uFEFF'];
for (let t = 0; t < 4000; t++) {
  const npieces = 1 + Math.floor(rnd() * 40);
  let s = '';
  for (let i = 0; i < npieces; i++) s += pieces[Math.floor(rnd() * pieces.length)];
  check(T(s, rnd() < 0.5), `fuzz#${t}`);
}
// fuzzer 2: record-structured texts with broken rows, closer to the real generator
const words = ['alpha', 'bravo', 'x', '42', '2024-01-01', 'São Paulo', "O'Brien", ''];
for (let t = 0; t < 1500; t++) {
  const eol = rnd() < 0.5 ? '\n' : '\r\n';
  const width = 1 + Math.floor(rnd() * 6);
  const lines = [];
  const nrec = Math.floor(rnd() * 12);
  for (let r = 0; r < nrec; r++) {
    let w = width;
    const roll = rnd();
    if (roll < 0.1) w = Math.max(1, width - 1);
    else if (roll < 0.2) w = width + 2;
    const fields = [];
    for (let f = 0; f < w; f++) {
      let v = words[Math.floor(rnd() * words.length)];
      const fr = rnd();
      if (fr < 0.15) v = `"${v.replaceAll('"', '""')}"`;
      else if (fr < 0.2) v = `"${v}"junk`;
      else if (fr < 0.24) v = `${v}\r${words[Math.floor(rnd() * words.length)]}`;
      else if (fr < 0.28) v = `"multi${eol}line"`;
      fields.push(v);
    }
    lines.push(fields.join(','));
    if (rnd() < 0.05) lines.push('');
  }
  let text = lines.join(eol);
  if (rnd() < 0.7) text += eol;
  if (rnd() < 0.1) text = `\uFEFF${text}`;
  if (rnd() < 0.08) text += '"never closed, tail\nmore, tail';
  check(T(text, rnd() < 0.6), `fuzz2#${t}`);
}

console.log(`difftest: ${total - failed}/${total} identical, ${failed} failed`);
process.exit(failed ? 1 : 0);
