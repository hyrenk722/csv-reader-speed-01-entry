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
const UCLASS = new Uint8Array(128);
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
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let i = pos + 1;
    let seg = i; // the start of the clean run not yet taken
    let parts = null; // slices and replacements, once a doubled quote or a CR is met
    for (;;) {
      if (i >= n) {
        // The quote never closes: it is a literal character, and the text after it is read again
        // as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"');
      }
      const c = text.charCodeAt(i);
      if (c === 34) {
        // '"'
        if (text.charCodeAt(i + 1) === 34) {
          if (parts === null) parts = [];
          parts.push(text.slice(seg, i));
          parts.push('"');
          i += 2;
          seg = i;
          continue;
        }
        // The closing quote.
        let value;
        if (parts === null) {
          value = text.slice(seg, i);
        } else {
          parts.push(text.slice(seg, i));
          value = parts.join('');
        }
        pos = i + 1;
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
      if (c === 13) {
        // CRLF and a lone CR inside quotes are each one LF.
        if (parts === null) parts = [];
        parts.push(text.slice(seg, i));
        parts.push('\n');
        line += 1;
        i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
        seg = i;
        continue;
      }
      if (c === 10) line += 1; // an LF inside quotes is kept as it stands and counts one line
      i += 1;
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
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        fields.push(readQuoted());
      } else {
        quoted = false;
        // The hot path, inline: a clean unquoted run to the next comma or line break.
        const seg = pos;
        let i = pos;
        while (i < n) {
          const cc = text.charCodeAt(i);
          if (cc < 128 ? UCLASS[cc] !== 0 : false) break;
          i += 1;
        }
        if (i >= n) {
          pos = n;
          fEnded = END;
          fields.push(text.slice(seg, i));
        } else {
          const c = text.charCodeAt(i);
          if (c === 44) {
            pos = i + 1;
            fEnded = COMMA;
            fields.push(text.slice(seg, i));
          } else if (c === 10) {
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
