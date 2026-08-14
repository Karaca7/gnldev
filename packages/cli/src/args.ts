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
