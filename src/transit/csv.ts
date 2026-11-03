/**
 * The CSV dialect GTFS uses: RFC 4180, comma separated, optional double
 * quotes with `""` as an escaped quote, CRLF or LF line endings, and a UTF-8
 * byte order mark that some producers still write at the start of a file.
 *
 * Rows come back as objects keyed by the header, so a feed that orders its
 * columns differently, or adds columns this package does not read, parses the
 * same way. A missing column reads as the empty string, which is what GTFS
 * means by an optional field left out.
 */
export type CsvRow = Record<string, string>;

export function parseCsv(text: string): CsvRow[] {
  const records = parseRecords(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (records.length === 0) return [];
  const header = records[0].map((name) => name.trim());
  const rows: CsvRow[] = [];
  for (let r = 1; r < records.length; r += 1) {
    const record = records[r];
    // A blank line, often a trailing newline, is not a row.
    if (record.length === 1 && record[0] === "") continue;
    const row: CsvRow = {};
    for (let c = 0; c < header.length; c += 1) row[header[c]] = record[c] ?? "";
    rows.push(row);
  }
  return rows;
}

const COMMA = 44;
const QUOTE = 34;
const LF = 10;
const CR = 13;

/**
 * Splits text into records of fields. Unquoted fields, which are nearly all of
 * a real feed, are sliced straight out of the text rather than built up a
 * character at a time: a stop_times.txt runs to tens of megabytes.
 */
function parseRecords(text: string): string[][] {
  const records: string[][] = [];
  const length = text.length;
  let record: string[] = [];
  let i = 0;
  while (i < length) {
    let field: string;
    if (text.charCodeAt(i) === QUOTE) {
      // Quoted field: may contain commas, newlines and doubled quotes.
      let value = "";
      let start = i + 1;
      i = start;
      for (;;) {
        const close = text.indexOf('"', i);
        if (close < 0) {
          value += text.slice(start);
          i = length;
          break;
        }
        if (text.charCodeAt(close + 1) === QUOTE) {
          value += text.slice(start, close + 1);
          i = close + 2;
          start = i;
          continue;
        }
        value += text.slice(start, close);
        i = close + 1;
        break;
      }
      // Anything between the closing quote and the delimiter is kept, which
      // is lenient towards producers that pad quoted fields.
      const tail = i;
      while (i < length) {
        const code = text.charCodeAt(i);
        if (code === COMMA || code === LF || code === CR) break;
        i += 1;
      }
      field = value + text.slice(tail, i);
    } else {
      const start = i;
      while (i < length) {
        const code = text.charCodeAt(i);
        if (code === COMMA || code === LF || code === CR) break;
        i += 1;
      }
      field = text.slice(start, i);
    }
    record.push(field);
    if (i >= length) break;
    const code = text.charCodeAt(i);
    if (code === COMMA) {
      i += 1;
      // A trailing comma at the very end still means one more, empty field.
      if (i >= length) record.push("");
      continue;
    }
    // End of record: CR, LF or CRLF.
    i += code === CR && text.charCodeAt(i + 1) === LF ? 2 : 1;
    records.push(record);
    record = [];
  }
  if (record.length > 0) records.push(record);
  return records;
}
