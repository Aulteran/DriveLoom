// RFC 4180 CSV reading and writing, plus spreadsheet formula neutralisation.

/** Characters that make a spreadsheet treat a cell as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Prefix risky text with an apostrophe so no spreadsheet executes it. Text that
 * already starts with an apostrophe gets one too, which keeps the encoding
 * unambiguous and the round trip lossless.
 */
export const neutralise = (v: string): string => (FORMULA_START.test(v) || v.startsWith("'") ? `'${v}` : v);
/** Undo `neutralise` on import. */
export const denormalise = (v: string): string => (v.startsWith("'") && (FORMULA_START.test(v.slice(1)) || v[1] === "'") ? v.slice(1) : v);

const quote = (v: string): string => (/[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function toCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [header, ...rows].map((r) => r.map(quote).join(',')).join('\r\n') + '\r\n';
}

export class CsvError extends Error {}

/** Parse CSV text into rows of cells. Throws CsvError on malformed quoting or on exceeding `maxRows`. */
export function parseCsv(text: string, maxRows: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', i = 0, quoted = false, wasQuoted = false;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const endCell = () => { row.push(cell); cell = ''; wasQuoted = false; };
  const endRow = () => {
    endCell();
    if (row.length > 1 || row[0] !== '') rows.push(row); // skip blank lines
    if (rows.length > maxRows + 1) throw new CsvError(`too many rows (limit ${maxRows})`);
    row = [];
  };
  while (i < s.length) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      cell += ch; i++; continue;
    }
    if (ch === '"') {
      if (cell !== '' || wasQuoted) throw new CsvError(`unexpected quote in row ${rows.length + 1}`);
      quoted = true; wasQuoted = true; i++; continue;
    }
    if (wasQuoted && ch !== ',' && ch !== '\r' && ch !== '\n') throw new CsvError(`text after closing quote in row ${rows.length + 1}`);
    if (ch === ',') { endCell(); i++; continue; }
    if (ch === '\r' || ch === '\n') { if (ch === '\r' && s[i + 1] === '\n') i++; endRow(); i++; continue; }
    cell += ch; i++;
  }
  if (quoted) throw new CsvError('unterminated quoted field');
  if (cell !== '' || row.length || wasQuoted) endRow();
  return rows;
}
