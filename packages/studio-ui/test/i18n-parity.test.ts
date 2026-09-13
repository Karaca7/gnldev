// en↔tr locale parity, mechanically. Before this test the only thing keeping the two trees equal
// was the discipline of whoever added a key — a PR touching only `en/inspector.json` shipped green
// and TR Studio showed raw keys until a user said so. File set and recursive key set must match.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', 'src', 'i18n', 'locales');

function keysOf(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => keysOf(v, prefix ? `${prefix}.${k}` : k));
}

describe('locale parity (en ↔ tr)', () => {
  const en = readdirSync(join(ROOT, 'en')).sort();
  const tr = readdirSync(join(ROOT, 'tr')).sort();

  it('both languages carry the same namespace files', () => {
    expect(tr).toEqual(en);
  });

  for (const file of en) {
    it(`${file}: same key set in both languages`, () => {
      const enKeys = keysOf(JSON.parse(readFileSync(join(ROOT, 'en', file), 'utf8'))).sort();
      const trKeys = keysOf(JSON.parse(readFileSync(join(ROOT, 'tr', file), 'utf8'))).sort();
      expect(trKeys).toEqual(enKeys);
    });
  }
});
