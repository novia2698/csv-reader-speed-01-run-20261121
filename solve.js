// A fast drop-in for csv-reader 1.0.0, make.fun's own CSV reader.
//
// It returns exactly the same answer for every input, {columns, rows, errors},
// under the same broken-row policy: a U+FEFF at the very start is dropped, a
// record ends at LF or CRLF, a blank line is no record, a CR outside quotes
// that is not followed by LF is dropped (stray_cr), a field that opens with a
// quote runs to the next quote that is not doubled ("" inside it is one quote,
// CRLF or a lone CR inside it reads as LF), what follows its closing quote up
// to the next comma or line break is appended as it stands (quote_junk), a
// quote that never closes is a literal character and the text after it is read
// again as unquoted (unterminated_quote), a quote inside an unquoted field is
// a literal character, fields stay strings, records are padded with "" or cut
// to the first record's width (short_row / long_row), and each error carries
// {code, line, row} in the order it was met.
//
// Where the reference grows every field one character at a time, this reader
// cuts fields out of the text with native indexOf: an unquoted field is one
// slice up to its next comma or line break, a quoted field is slices between
// its quotes, and a whole plain record with no quote and no stray CR in it is
// split at once. The slow paths only run on records that actually hold a
// quote or a stray CR, which are a small share of every file.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input, faster. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and its index in rows (null: the header).
  let recordLine = 1;
  let recordRow = null;

  /** How many LF characters a string holds. */
  function countLF(s) {
    let c = 0;
    let i = -1;
    while ((i = s.indexOf('\n', i + 1)) !== -1) c += 1;
    return c;
  }

  // A stretch of a quoted field, with its line breaks counted and its CRs
  // read as LF: each CRLF and each lone CR inside quotes is one LF.
  function normalizeQuoted(seg) {
    if (seg.indexOf('\r') === -1) {
      line += countLF(seg);
      return seg;
    }
    const out = seg.replace(/\r\n?/g, '\n');
    line += countLF(out);
    return out;
  }

  // Reads unquoted characters onto `init` up to the next comma or line break.
  // A CR not followed by LF is dropped (stray_cr). Returns the field, how it
  // ended, and `added`: the characters kept (the initial value is not counted).
  function readUnquoted(init) {
    let value = init;
    let added = 0;
    for (;;) {
      const ci = text.indexOf(',', pos);
      const ni = text.indexOf('\n', pos);
      let m;
      let isComma;
      if (ci === -1 && ni === -1) {
        m = n;
        isComma = false;
      } else if (ni === -1 || (ci !== -1 && ci < ni)) {
        m = ci;
        isComma = true;
      } else {
        m = ni;
        isComma = false;
      }
      const atEnd = m === n;
      const seg = text.slice(pos, m);
      if (seg.indexOf('\r') !== -1) {
        // Every CR in this stretch is stray and dropped, except a CR that
        // sits right before the LF ending the field: that pair is one CRLF.
        // No other CRLF can hide here: the LF at m is the first one past pos.
        let body = seg;
        if (!isComma && !atEnd && seg.charCodeAt(seg.length - 1) === 13) body = seg.slice(0, -1);
        let bad = 0;
        for (let i = body.indexOf('\r'); i !== -1; i = body.indexOf('\r', i + 1)) bad += 1;
        for (let k = 0; k < bad; k += 1) errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        const clean = bad === 0 ? body : body.replace(/\r/g, '');
        added += clean.length;
        value += clean;
        if (atEnd) {
          pos = n;
          return { value, ended: END, added };
        }
        if (isComma) {
          pos = m + 1;
          return { value, ended: COMMA, added };
        }
        pos = m + 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      added += seg.length;
      value += seg;
      if (atEnd) {
        pos = n;
        return { value, ended: END, added };
      }
      if (isComma) {
        pos = m + 1;
        return { value, ended: COMMA, added };
      }
      pos = m + 1;
      line += 1;
      return { value, ended: LINE_BREAK, added };
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"');
      }
      const seg = text.slice(pos, q);
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote is one quote inside the field; keep reading.
        value += normalizeQuoted(seg);
        value += '"';
        pos = q + 2;
        continue;
      }
      value += normalizeQuoted(seg);
      pos = q + 1;
      if (pos >= n) return { value, ended: END, added: 0 };
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        return { value, ended: COMMA, added: 0 };
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        return { value, ended: LINE_BREAK, added: 0 };
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        return { value, ended: LINE_BREAK, added: 0 };
      }
      // What follows the closing quote is appended as it stands, up to the
      // next comma or line break.
      const junk = readUnquoted(value);
      if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      return junk;
    }
  }

  while (true) {
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

    // Fast path: the whole record sits on one line with no quote and no
    // stray CR in it, so one native split gives all of its fields. A line
    // that holds a quote or a CR falls through to the field-by-field reader.
    const nl = text.indexOf('\n', pos);
    const hasEol = nl !== -1;
    const recEnd = hasEol ? nl : n;
    let segEnd = recEnd;
    if (hasEol && segEnd > pos && text.charCodeAt(segEnd - 1) === 13) segEnd -= 1;
    const seg = text.slice(pos, segEnd);
    let fields;
    if (seg.indexOf('"') === -1 && seg.indexOf('\r') === -1) {
      fields = seg.split(',');
      pos = hasEol ? nl + 1 : n;
      if (hasEol) line += 1;
    } else {
      fields = [];
      let field;
      let quoted = false;
      do {
        quoted = text.charCodeAt(pos) === 34;
        field = quoted ? readQuoted() : readUnquoted('');
        fields.push(field.value);
      } while (field.ended === COMMA);
      // A line that held only stray CRs is left with no characters: no
      // record (its stray_cr errors stay).
      if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    }

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
