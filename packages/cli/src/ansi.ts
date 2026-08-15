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

/** completed -> green, suspended -> yellow, failed -> red, running -> cyan, canceled -> dim (else uncolored). */
export function colorStatus(status: string): string {
  if (status === 'suspended') return yellow(status);
  if (status === 'completed') return green(status);
  // The newest status and the one most worth noticing was the only one printed without colour.
  if (status === 'failed') return red(status);
  if (status === 'running') return cyan(status); // live, matching the studio's info tone
  // There is no grey helper here (the palette is four hand-rolled SGR codes, and a 90m bright-black
  // Is illegible on the light terminals that render it as pale grey). `dim` is the muted tone this
  // File already owns, and it reads correctly on both backgrounds — the Studio's muted-foreground in
  // The vocabulary this renderer actually has. Both spellings: the durable RunStatus is 'canceled',
  // while the workflow engine's own status strings say 'cancelled', and both reach printTable.
  if (status === 'canceled' || status === 'cancelled') return dim(status);
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
