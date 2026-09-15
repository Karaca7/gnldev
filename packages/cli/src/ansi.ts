// Minimal zero-dependency ANSI color + table rendering (no chalk/ora - see packages/cli/package.json:
// the CLI ships with zero NEW runtime dependencies, colors are hand-rolled escape codes).

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
  // is illegible on the light terminals that render it as pale grey). `dim` is the muted tone this
  // file already owns, and it reads correctly on both backgrounds — the Studio's muted-foreground in
  // the vocabulary this renderer actually has. Both spellings: the durable RunStatus is 'canceled',
  // while the workflow engine's own status strings say 'cancelled', and both reach printTable.
  if (status === 'canceled' || status === 'cancelled') return dim(status);
  return status;
}

const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/**
 * How many terminal COLUMNS one code point occupies. Not the same question as `.length`.
 *
 * `.length` counts UTF-16 code units, and every alignment in this file used it:
 *   `支払い完了`  five code points, five units, TEN columns  -> the table under-measured by five
 *   `🎉`          one code point, TWO units, two columns     -> over-measured by nothing, but a cut
 *                 at an odd offset lands BETWEEN the surrogates and emits half a character
 *
 * The consequence is not cosmetic. `gnl runs` prints THREAD and WORK KEY, which are the user's own
 * strings — a Japanese thread title made every column after it step right, and the same
 * miscount in the prompt is what puts a line past the edge and back into the wrapping that the
 * clamp exists to prevent.
 *
 * The ranges are the practical ones (CJK, Hangul, fullwidth forms, emoji), not a full Unicode width
 * table: this package ships no runtime dependency for colour and is not about to take one for width.
 * Combining marks and variation selectors are zero, which is what keeps `é` and an emoji with a skin
 * tone from being counted twice.
 */
function codePointWidth(cp: number): number {
  if (cp === 0x200d || (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff)
    || (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

/** Visible width in terminal columns: colour costs nothing, a CJK character costs two. */
export function displayWidth(s: string): number {
  let n = 0;
  for (const ch of stripAnsi(s)) n += codePointWidth(ch.codePointAt(0)!);
  return n;
}

/**
 * Cut to `width` COLUMNS, never inside a character.
 *
 * Iterating with `for…of` walks code points, so a surrogate pair moves as one unit and cannot be
 * split — the failure that left `\ud83d` alone on screen. Colour sequences are copied through
 * whole and cost no columns.
 */
export function truncateToWidth(s: string, width: number): string {
  if (displayWidth(s) <= width) return s;
  // The ellipsis is itself one column, so anything under two has no room for content beside it.
  // `Math.max(1, …)` used to floor the budget at one and then append the ellipsis anyway, which
  // returned two columns for a width of one — a truncation that overflows is worse than none.
  if (width <= 0) return '';
  if (width === 1) return '…';
  const budget = width - 1;
  let out = '';
  let used = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === ESC) {                       // copy the whole escape, it costs no columns
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    const w = codePointWidth(ch.codePointAt(0)!);
    if (used + w > budget) break;
    out += ch;
    used += w;
    i += ch.length;
  }
  return `${out}…`;
}

/** Simple column-aligned table - no external table dep. Prints directly to stdout. */
export function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ''))));
  const line = (cols: string[]) => cols.map((c, i) => c + ' '.repeat(Math.max(0, widths[i]! - displayWidth(c)))).join('  ');
  console.log(dim(line(headers)));
  for (const r of rows) console.log(line(r));
}
