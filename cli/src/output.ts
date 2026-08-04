const COL_MAX_WIDTH = 40;

/**
 * Format data as a column-aligned table.  Each column is at most COL_MAX_WIDTH
 * characters wide; longer values are truncated to 37 chars + "…".
 */
export function printTable(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    console.log('(none)');
    return;
  }

  const keys = Object.keys(rows[0]);
  const widths = keys.map((k) => {
    const max = rows.reduce((m, r) => {
      const val = String(r[k] ?? '');
      return Math.max(m, val.length);
    }, k.length);
    return Math.min(max, COL_MAX_WIDTH);
  });

  // Header
  const header = keys.map((k, i) => pad(k, widths[i])).join('  ');
  console.log(header);

  // Separator
  console.log(keys.map((_, i) => '-'.repeat(widths[i])).join('  '));

  // Rows
  for (const row of rows) {
    const line = keys.map((k, i) => pad(trunc(String(row[k] ?? ''), widths[i]), widths[i])).join('  ');
    console.log(line);
  }
}

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function trunc(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

function pad(s: string, width: number): string {
  return s.padEnd(width);
}
