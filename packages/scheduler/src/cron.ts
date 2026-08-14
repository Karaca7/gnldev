// Minimal 5-field cron (minute resolution, UTC). Supports '*', list ',', range '-', step '/'.
// Dom/dow POSIX OR semantics: if both are restricted, "day-of-month OR day-of-week"; if one is '*', the other decides.

/** Converts a cron field into the set of allowed values within [min,max]. */
export function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const [rangeRaw, stepRaw] = part.split('/');
    const step = stepRaw !== undefined ? parseInt(stepRaw, 10) : 1;
    if (!Number.isFinite(step) || step < 1) throw new Error(`cron: invalid step '${part}'`);
    let lo: number;
    let hi: number;
    if (rangeRaw === '*' || rangeRaw === '') {
      lo = min;
      hi = max;
    } else if (rangeRaw.includes('-')) {
      const [a, b] = rangeRaw.split('-').map((x) => parseInt(x, 10));
      lo = a!;
      hi = b!;
    } else {
      lo = hi = parseInt(rangeRaw, 10);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`cron: invalid range '${part}' (expected ${min}-${max})`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/**
 * Returns the first cron match (epoch ms, minute boundary) AFTER the `after` (epoch ms) time.
 * 5 fields: minute hour day-of-month month day-of-week (0=Sunday). UTC. Minute-by-minute scan, 366-day cap.
 */
export function nextCronTime(expr: string, after: number): number {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron expects 5 fields (min hour day month weekday): '${expr}'`);
  const min = parseField(fields[0]!, 0, 59);
  const hour = parseField(fields[1]!, 0, 23);
  const dom = parseField(fields[2]!, 1, 31);
  const mon = parseField(fields[3]!, 1, 12);
  const dow = parseField(fields[4]!, 0, 6);
  const domRestricted = fields[2] !== '*';
  const dowRestricted = fields[4] !== '*';

  let t = Math.ceil((after + 1) / 60000) * 60000; // next minute boundary
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i++, t += 60000) {
    const d = new Date(t);
    if (!min.has(d.getUTCMinutes())) continue;
    if (!hour.has(d.getUTCHours())) continue;
    if (!mon.has(d.getUTCMonth() + 1)) continue;
    const domOk = dom.has(d.getUTCDate());
    const dowOk = dow.has(d.getUTCDay());
    const dayOk = domRestricted && dowRestricted ? domOk || dowOk : domOk && dowOk;
    if (dayOk) return t;
  }
  throw new Error(`cron: no match within 1 year: '${expr}'`);
}
