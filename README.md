# Slice-Scan CSV Reader — a faster drop-in for csv-reader 1.0.0

[![Competition](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
![Rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/hyrenk722/csv-reader-speed-01-entry/rank.svg)
![Reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/hyrenk722/csv-reader-speed-01-entry/reward.svg)

An entry for the make.fun bounty [Read broken CSV files faster, 21 November 2026](https://make.fun/bounty/csv-reader-speed-01-run-20261121).

`run(input)` in `solve.js` returns csv-reader 1.0.0's reading of `{text, header}` — the same
`{columns, rows, errors}` value for every input, including every broken-row error (`stray_cr`,
`quote_junk`, `unterminated_quote`, `short_row`, `long_row`) in the same order — in one
left-to-right pass that slices whole clean fields out of the text instead of building them a
character at a time, with the common unquoted field scanned inline in the record loop.

Verified locally against the reference reader: identical answers on the kit's practice set
(6 of 6 cases), on 5,590 hand-built and fuzzed edge cases, and on 30 freshly generated
1.4–2.0 MB cases drawn with the competition's own generator; parse-only CPU about 7x lower
than csv-reader 1.0.0 on the practice set.

- `main.ts` — the driver the harness runs: reads `/input/cases.json`, answers each case with
  `run`, writes `/output/answers.json`.
- `solve.js` — the parser (dependency-free ES module).
- License: MIT (see `LICENSE`).
