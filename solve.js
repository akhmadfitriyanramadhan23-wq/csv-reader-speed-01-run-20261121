// solve.js — a fast drop-in for make.fun's csv-reader 1.0.0.
//
// run(input) returns exactly what csv-reader 1.0.0 returns for the same
// input {text, header}: {columns, rows, errors}. It reads the text once,
// left to right, with the reference's broken-row policy:
//
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (error stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled,
//     "" inside it one quote and each CRLF or lone CR inside it read as LF;
//     what follows its closing quote, up to the next comma or line break, is
//     appended as it stands (quote_junk, when the field ends);
//   - a quote that never closes is a literal character, and the text after it
//     is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character;
//   - fields stay strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the
//     records after it, each padded (short_row) or cut (long_row) to the first
//     record's width; each error is {code, line, row} in the order met.
//
// Speed: the reference builds every field a character at a time. This one
// finds each field's end with a native scan and slices it out whole. A record
// that holds no quote and no CR (besides a trailing CRLF) is split on commas
// in one native call. Quoted fields are scanned for their next special
// character only, and their line breaks counted as they are met.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the next.

/** How a field ended: 0 at a comma, 1 at a line break, 2 at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = text.charCodeAt(0) === 0xFEFF ? 1 : 0;
  let line = 1;

  // The next terminator of an unquoted field: comma, CR or LF.
  const UNQUOTED = /[,\r\n]/g;
  // The next special character inside a quoted field: quote, CR or LF.
  const QUOTED = /["\r\n]/g;
  // The next quote or CR at or after a record's start: the clean-record check.
  const CHECK = /["\r]/g;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `value` up to the next comma or line break: a CR not followed by LF is dropped
  // (stray_cr). Returns the field and how it ended; `added` counts the characters kept.
  function readUnquoted(value) {
    let added = 0;
    let seg = pos;
    UNQUOTED.lastIndex = pos;
    let m;
    while ((m = UNQUOTED.exec(text)) !== null) {
      const i = m.index;
      const c = text.charCodeAt(i);
      if (c === 44) { // ','
        value += text.slice(seg, i);
        added += i - seg;
        pos = i + 1;
        return { value, ended: COMMA, added };
      }
      if (c === 10) { // '\n'
        value += text.slice(seg, i);
        added += i - seg;
        pos = i + 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      // '\r': a line break with the LF that follows it, else a stray CR, dropped.
      if (text.charCodeAt(i + 1) === 10) {
        value += text.slice(seg, i);
        added += i - seg;
        pos = i + 2;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      error('stray_cr');
      value += text.slice(seg, i);
      added += i - seg;
      seg = i + 1;
      UNQUOTED.lastIndex = i + 1;
    }
    value += text.slice(seg);
    added += len - seg;
    pos = len;
    return { value, ended: END, added };
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    let seg = pos + 1;
    QUOTED.lastIndex = pos + 1;
    let closed = -1;
    let m;
    while ((m = QUOTED.exec(text)) !== null) {
      const i = m.index;
      const c = text.charCodeAt(i);
      if (c === 34) { // '"'
        if (text.charCodeAt(i + 1) === 34) { // '""' inside it is one quote
          value += text.slice(seg, i) + '"';
          seg = i + 2;
          QUOTED.lastIndex = i + 2;
          continue;
        }
        value += text.slice(seg, i);
        closed = i;
        break;
      }
      // CRLF and a lone CR inside quotes are each one LF.
      value += text.slice(seg, i) + '\n';
      line += 1;
      if (c === 13 && text.charCodeAt(i + 1) === 10) {
        seg = i + 2;
        QUOTED.lastIndex = i + 2;
      } else {
        seg = i + 1;
        QUOTED.lastIndex = i + 1;
      }
    }
    if (closed < 0) {
      // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      error('unterminated_quote');
      return readUnquoted('"');
    }
    pos = closed + 1;
    if (pos >= len) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
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
    while (pos < len) {
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
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // A record that holds no quote and no CR (besides a trailing CRLF) is split on commas in one call.
    // CHECK finds the first quote or CR at or after pos: a match at or past contentEnd means the record's
    // content holds neither — a CR at contentEnd itself is the trailing CRLF's, already cut off above.
    const nl = text.indexOf('\n', pos);
    const spanEnd = nl < 0 ? len : nl;
    const contentEnd = nl >= 0 && spanEnd > pos && text.charCodeAt(spanEnd - 1) === 13 ? spanEnd - 1 : spanEnd;
    let fields;
    let quoted = false;
    if (contentEnd > pos) {
      CHECK.lastIndex = pos;
      const bad = CHECK.exec(text);
      if (bad === null || bad.index >= contentEnd) {
        fields = text.slice(pos, contentEnd).split(',');
        pos = nl < 0 ? len : nl + 1;
        if (nl >= 0) line += 1;
      }
    }
    if (fields === undefined) {
      // A record with a quote or a CR in it: read it a field at a time.
      fields = [];
      let field;
      do {
        quoted = text.charCodeAt(pos) === 34;
        field = quoted ? readQuoted() : readUnquoted('');
        fields.push(field.value);
      } while (field.ended === COMMA);
    }

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
