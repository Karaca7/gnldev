// Minimal zero-dependency arg parsing — the same flag()/positional() convention cli.ts always used,
// Factored out so every command module can share it (kept intentionally tiny: no new runtime dep).

/** `--name value` anywhere in argv. */
export function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** `--name` present anywhere in argv (boolean switch). */
export function flagBool(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

/** The i-th positional (non-flag) argument. Only argv[i] is checked — flags are expected AFTER positionals. */
export function positional(argv: string[], i: number): string | undefined {
  const v = argv[i];
  return v && !v.startsWith('--') ? v : undefined;
}

/**
 * Every positional, with the VALUES of `--name value` flags excluded.
 *
 * `positional()` above only works when flags come last, which is the convention but not something a
 * user knows. The obvious alternative — `argv.filter((a) => !a.startsWith('-'))` — silently counts a
 * flag's value as a positional, so `gnl pricing set --input 5 --output 10 my-model` read its model
 * name as "5" and wrote a price for a model called 5. No error: the command reported success, the
 * table gained a junk row, and the model the user meant to price stayed unpriced — which for a
 * pricing table means maxCostUsd goes on not capping the model they just tried to fix.
 *
 * `valueFlags` names the flags that consume the following token. Boolean switches must NOT be listed,
 * or the token after them is eaten.
 */
export function positionals(argv: string[], valueFlags: readonly string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('-')) { out.push(a); continue; }
    // `--name=value` carries its value inline, so the next token is a positional.
    if (!a.includes('=') && valueFlags.includes(a.replace(/^--?/, ''))) i++;
  }
  return out;
}
