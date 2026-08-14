// Minimal zero-dependency ANSI color + table rendering (no chalk/ora - see packages/cli/package.json:
// The CLI ships with zero NEW runtime dependencies, colors are hand-rolled escape codes).

const ESC = '\x1b';

/** Colors are only emitted for an interactive TTY, and never if NO_COLOR is set (https://no-color.org/). */
function colorEnabled(): boolean {
  return !process.env.NO_COLOR && !!process.stdout.isTTY;
}

function wrap(code: string): (s: string) => string {
  return (s: string) => (colorEnabled() ? `${ESC}[${code}m${s}${ESC}[0m` : s);
}

export const dim = wrap('2');
export const bold = wrap('1');
export const green = wrap('32');
export const red = wrap('31');
export const yellow = wrap('33');
export const cyan = wrap('36');

/** completed -> green, suspended -> yellow (anything else passes through uncolored). */
export function colorStatus(status: string): string {
  if (status === 'suspended') return yellow(status);
  if (status === 'completed') return green(status);
  return status;
}

const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** Simple column-aligned table - no external table dep. Prints directly to stdout. */
export function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(stripAnsi(h).length, ...rows.map((r) => stripAnsi(r[i] ?? '').length)));
  const line = (cols: string[]) => cols.map((c, i) => c + ' '.repeat(Math.max(0, widths[i]! - stripAnsi(c).length))).join('  ');
  console.log(dim(line(headers)));
  for (const r of rows) console.log(line(r));
}
