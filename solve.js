// A fast CSV reader that returns exactly what csv-reader 1.0.0 returns for an input {text, header}:
// the value {columns, rows, errors}. It applies the same broken-row policy as the reference, but reads
// the text in slices instead of a character at a time: each field is located with indexOf jumps and cut
// out with slice, and only the rare field that hides a carriage return is walked character by character.
//
// The policy, as the reference applies it:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - a CR outside quotes that is not part of a CRLF is dropped (error stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled ("" inside it is one
//     quote, and each CRLF or lone CR inside it is read as one LF); what follows the closing quote, up
//     to the next comma or line break, is appended as it stands (error quote_junk, when anything was
//     appended);
//   - a quote that never closes is a literal character, and the text after it is read again as an
//     unquoted field (error unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never trimmed or
//     converted;
//   - columns is the first record when header is true, else null; every other record is padded with ""
//     (error short_row, with fields: its own field count) or cut (error long_row, with extra: the cut
//     fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts on (every LF, CRLF and
//     lone CR inside a quoted field counted), row its record's index in rows (null for the header),
//     in the order met.
//
// Pure: nothing is kept from one call to the next.

/** How a field ended: at a comma, at a line break, or at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

const CH_COMMA = 44;
const CH_LF = 10;
const CH_CR = 13;
const CH_QUOTE = 34;

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
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
  // Both are fixed before its fields are read, and every error it raises carries them.
  let recordLine = 1;
  let recordRow = null;

  // The field read last: its value, how it ended, and how many characters the last unquoted read kept
  // (the quote_junk test). Kept in locals so a field costs no result object.
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  function fail(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `prefix` up to the next comma or line break, dropping each CR that
  // is not part of a CRLF (stray_cr). Sets fValue, fEnded and fAdded.
  function readUnquoted(prefix) {
    let value = prefix;
    let added = 0;
    for (;;) {
      if (pos >= n) {
        fValue = value;
        fEnded = END;
        fAdded = added;
        return;
      }
      // Jump to the nearer of the next comma and the next LF; the field's segment runs up to it.
      const iComma = text.indexOf(',', pos);
      const iLf = text.indexOf('\n', pos);
      let end;
      let term;
      if (iLf === -1 || (iComma !== -1 && iComma < iLf)) {
        end = iComma;
        term = COMMA;
      } else {
        end = iLf;
        term = LINE_BREAK;
      }
      if (end === -1) {
        end = n;
        term = END;
      }
      if (end > pos) {
        const seg = text.slice(pos, end);
        if (seg.indexOf('\r') !== -1) {
          // The segment hides a carriage return: walk it character by character from pos, applying
          // the stray-CR and CRLF rules, until the field ends wherever it ends.
          let j = pos;
          for (;;) {
            if (j >= n) {
              pos = n;
              fEnded = END;
              break;
            }
            const c = text.charCodeAt(j);
            if (c === CH_COMMA) {
              pos = j + 1;
              fEnded = COMMA;
              break;
            }
            if (c === CH_LF) {
              pos = j + 1;
              line += 1;
              fEnded = LINE_BREAK;
              break;
            }
            if (c === CH_CR) {
              if (text.charCodeAt(j + 1) === CH_LF) {
                pos = j + 2;
                line += 1;
                fEnded = LINE_BREAK;
                break;
              }
              fail('stray_cr');
              j += 1;
              continue;
            }
            let k = j + 1;
            while (k < n) {
              const d = text.charCodeAt(k);
              if (d === CH_COMMA || d === CH_LF || d === CH_CR) break;
              k += 1;
            }
            value += text.slice(j, k);
            added += k - j;
            j = k;
          }
          fValue = value;
          fAdded = added;
          return;
        }
        value += seg;
        added += seg.length;
      }
      if (term === COMMA) {
        pos = end + 1;
        fEnded = COMMA;
      } else if (term === LINE_BREAK) {
        pos = end + 1;
        line += 1;
        fEnded = LINE_BREAK;
      } else {
        pos = n;
        fEnded = END;
      }
      fValue = value;
      fAdded = added;
      return;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Sets fValue and fEnded.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    let closed = false;
    while (pos < n) {
      const q = text.indexOf('"', pos);
      if (q === -1) break;
      if (q > pos) {
        const seg = text.slice(pos, q);
        if (seg.indexOf('\r') === -1) {
          // No carriage return: the segment stands as it is, and only its LFs move the line.
          let k = seg.indexOf('\n');
          while (k !== -1) {
            line += 1;
            k = seg.indexOf('\n', k + 1);
          }
          value += seg;
        } else {
          // A carriage return inside quotes is read as one LF, a CRLF as one LF too: walk the
          // segment, rewriting each CR or CRLF to a single LF and counting lines as they pass.
          for (let i = pos; i < q; i += 1) {
            const c = text.charCodeAt(i);
            if (c === CH_CR) {
              value += '\n';
              line += 1;
              if (i + 1 < q && text.charCodeAt(i + 1) === CH_LF) i += 1;
            } else {
              if (c === CH_LF) line += 1;
              value += text[i];
            }
          }
        }
      }
      if (text.charCodeAt(q + 1) === CH_QUOTE) {
        value += '"';
        pos = q + 2;
        continue;
      }
      pos = q + 1;
      closed = true;
      break;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text after it is read again as
      // unquoted, from the start, with the line count as it was at the opening quote.
      pos = open + 1;
      line = openLine;
      fail('unterminated_quote');
      readUnquoted('"');
      return;
    }
    if (pos >= n) {
      fValue = value;
      fEnded = END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === CH_COMMA) {
      pos += 1;
      fValue = value;
      fEnded = COMMA;
      return;
    }
    if (c === CH_LF) {
      pos += 1;
      line += 1;
      fValue = value;
      fEnded = LINE_BREAK;
      return;
    }
    if (c === CH_CR && text.charCodeAt(pos + 1) === CH_LF) {
      pos += 2;
      line += 1;
      fValue = value;
      fEnded = LINE_BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the next comma or line break.
    readUnquoted(value);
    if (fAdded > 0) fail('quote_junk');
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === CH_LF) {
        pos += 1;
        line += 1;
      } else if (c === CH_CR && text.charCodeAt(pos + 1) === CH_LF) {
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
    for (;;) {
      quoted = text.charCodeAt(pos) === CH_QUOTE;
      if (quoted) readQuoted();
      else readUnquoted('');
      fields.push(fValue);
      if (fEnded !== COMMA) break;
    }

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
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
