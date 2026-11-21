// A fast drop-in for csv-reader 1.0.0: run(input) returns csv-reader's reading of {text, header} —
// {columns, rows, errors} — for every input, the same values, read in one left-to-right pass that
// slices whole clean fields out of the text instead of building them a character at a time, with
// the common unquoted field scanned inline in the record loop.
//
// The reading policy (make.fun's own, as csv-reader 1.0.0 states it):
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (error stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled: "" inside it is one
//     quote, and each CRLF or lone CR inside it is read as LF; what follows its closing quote, up to
//     the next comma or line break, is appended as it stands (error quote_junk, when the field ends);
//     a quote that never closes is a literal character and the text after it is read again as an
//     unquoted field (error unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never trimmed;
//   - columns is the first record when header is true, else null; rows holds the records after it
//     (every record when header is false), each padded with "" (error short_row, with fields: its
//     count) or cut (error long_row, with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row} in the order met: line the 1-based line its record starts on
//     (every LF, CRLF and lone CR inside a quoted field counted), row its record's index in rows,
//     null for the header.
//
// Pure: no state is kept from one call to the next.

const COMMA = 0;
const BREAK = 1;
const END = 2;

// Class of a character inside an unquoted field: 0 plain, 1 comma, 2 LF, 3 CR.
// Sized 65536 so every charCodeAt value indexes it directly, with no range guard.
const UCLASS = new Uint8Array(65536);
UCLASS[44] = 1;
UCLASS[10] = 2;
UCLASS[13] = 3;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // How the field just read ended, and (for an unquoted read) how many characters it kept.
  let fEnded = END;
  let fAdded = 0;

  // The slow path of an unquoted read, entered with i at a stray CR (not yet consumed): seg..i is
  // the clean run before it, parts the slices already taken (or null), value the prefix the field
  // already holds, added the characters kept so far. Drops the CR (stray_cr) and reads on, one
  // clean run at a time, to the field's end. Sets fEnded and fAdded.
  // Copy 3 of 3 of the unquoted-field scan — the same rule lives inline in the record loop and
  // in readUnquoted; change all three together.
  function unquotedTail(value, parts, seg, i, added) {
    for (;;) {
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      added += i - seg;
      if (parts === null) {
        parts = [];
        if (value !== '') parts.push(value);
      }
      if (i > seg) parts.push(text.slice(seg, i));
      i += 1;
      seg = i;
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c === 44 || c === 10 || c === 13) break;
        i += 1;
      }
      if (i >= n) {
        pos = n;
        fEnded = END;
        added += i - seg;
        fAdded = added;
        parts.push(text.slice(seg, i));
        return parts.join('');
      }
      const c = text.charCodeAt(i);
      if (c === 44) {
        pos = i + 1;
        fEnded = COMMA;
        added += i - seg;
        fAdded = added;
        parts.push(text.slice(seg, i));
        return parts.join('');
      }
      if (c === 10) {
        pos = i + 1;
        line += 1;
        fEnded = BREAK;
        added += i - seg;
        fAdded = added;
        parts.push(text.slice(seg, i));
        return parts.join('');
      }
      if (text.charCodeAt(i + 1) === 10) {
        pos = i + 2;
        line += 1;
        fEnded = BREAK;
        added += i - seg;
        fAdded = added;
        parts.push(text.slice(seg, i));
        return parts.join('');
      }
      // Another stray CR: loop and drop it too.
    }
  }

  // Reads unquoted characters onto `value` up to the next comma or line break: a CR not followed
  // by LF is dropped (stray_cr, by unquotedTail). Sets fEnded and fAdded (the characters this read
  // itself kept).
  // Copy 2 of 3 of the unquoted-field scan — the same rule lives inline in the record loop and
  // in unquotedTail; change all three together.
  function readUnquoted(value) {
    const seg = pos;
    let i = pos;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 44 || c === 10 || c === 13) break;
      i += 1;
    }
    if (i >= n) {
      pos = n;
      fEnded = END;
      fAdded = i - seg;
      return value + text.slice(seg, i);
    }
    const c = text.charCodeAt(i);
    if (c === 44) {
      pos = i + 1;
      fEnded = COMMA;
      fAdded = i - seg;
      return value + text.slice(seg, i);
    }
    if (c === 10) {
      pos = i + 1;
      line += 1;
      fEnded = BREAK;
      fAdded = i - seg;
      return value + text.slice(seg, i);
    }
    if (text.charCodeAt(i + 1) === 10) {
      pos = i + 2;
      line += 1;
      fEnded = BREAK;
      fAdded = i - seg;
      return value + text.slice(seg, i);
    }
    return unquotedTail(value, null, seg, i, 0);
  }

  // Reads a quoted field whose opening quote is at pos. Sets fEnded.
  // Fast scan: jump with native indexOf to the next quote, then work only on
  // the slice up to it — every later scan (for CR, for LF) is bounded to that
  // short slice, never to the rest of the text. The common clean field then
  // costs a few native scans instead of one JS step per character. A CR inside
  // the slice is folded to one LF exactly as the old per-character loop did.
  // (seg is always i at the top of the loop: both move together after every
  // doubled quote and every folded CR.)
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let i = pos + 1;
    let parts = null; // slices and replacements, once a doubled quote or a CR is met
    for (;;) {
      const q = text.indexOf('"', i);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after it is read again
        // as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"');
      }
      const span = text.slice(i, q);
      const r = span.indexOf('\r');
      if (r !== -1) {
        // A CR sits before the next quote: count the LFs before it, fold it to one LF.
        let p = span.indexOf('\n');
        while (p !== -1 && p < r) {
          line += 1;
          p = span.indexOf('\n', p + 1);
        }
        if (parts === null) parts = [];
        parts.push(span.slice(0, r));
        parts.push('\n');
        line += 1;
        i += r + (text.charCodeAt(i + r + 1) === 10 ? 2 : 1);
        continue;
      }
      // No CR before the next quote: count the LFs in the span.
      let p = span.indexOf('\n');
      while (p !== -1) {
        line += 1;
        p = span.indexOf('\n', p + 1);
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote: one literal quote, keep scanning.
        if (parts === null) parts = [];
        parts.push(span);
        parts.push('"');
        i = q + 2;
        continue;
      }
      // The closing quote.
      let value;
      if (parts === null) {
        value = span;
      } else {
        parts.push(span);
        value = parts.join('');
      }
      pos = q + 1;
      if (pos >= n) {
        fEnded = END;
        return value;
      }
      const d = text.charCodeAt(pos);
      if (d === 44) {
        pos += 1;
        fEnded = COMMA;
        return value;
      }
      if (d === 10) {
        pos += 1;
        line += 1;
        fEnded = BREAK;
        return value;
      }
      if (d === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        fEnded = BREAK;
        return value;
      }
      // What follows the closing quote is appended as it stands, up to the next comma or line
      // break.
      const junk = readUnquoted(value);
      if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      return junk;
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      const c0 = text.charCodeAt(pos);
      if (c0 === 34) {
        quoted = true;
        fields.push(readQuoted());
      } else if (c0 === 44) {
        // Empty field ending at a comma: the hot loop would stop at once here.
        quoted = false;
        pos += 1;
        fEnded = COMMA;
        fields.push('');
      } else if (c0 === 10) {
        // Empty field ending at a line break.
        quoted = false;
        pos += 1;
        line += 1;
        fEnded = BREAK;
        fields.push('');
      } else if (c0 === 13) {
        // Empty field at a CR: CRLF ends it, a lone CR drops and the tail reads on.
        quoted = false;
        if (text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line += 1;
          fEnded = BREAK;
          fields.push('');
        } else {
          fields.push(unquotedTail('', null, pos, pos, 0));
        }
      } else {
        quoted = false;
        // The hot path, inline: a clean unquoted run to the next comma or line break.
        // Copy 1 of 3 of the unquoted-field scan — the same rule lives in readUnquoted and
        // unquotedTail; change all three together.
        const seg = pos;
        let i = pos;
        let cls = 0; // the UCLASS value at i: 0 plain, 1 comma, 2 LF, 3 CR
        while (i < n) {
          cls = UCLASS[text.charCodeAt(i)];
          if (cls !== 0) break;
          i += 1;
        }
        if (i >= n) {
          pos = n;
          fEnded = END;
          fields.push(text.slice(seg, i));
        } else {
          if (cls === 1) {
            pos = i + 1;
            fEnded = COMMA;
            fields.push(text.slice(seg, i));
          } else if (cls === 2) {
            pos = i + 1;
            line += 1;
            fEnded = BREAK;
            fields.push(text.slice(seg, i));
          } else if (text.charCodeAt(i + 1) === 10) {
            pos = i + 2;
            line += 1;
            fEnded = BREAK;
            fields.push(text.slice(seg, i));
          } else {
            fields.push(unquotedTail('', null, seg, i, 0));
          }
        }
      }
    } while (fEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its errors stay).
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
  return { columns: header ? columns ?? [] : null, rows, errors };
}
