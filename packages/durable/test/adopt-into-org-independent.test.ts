// `adoptIntoOrg` — the upgrade path from a free, org-less deployment to a paid one.
//
// The dangerous half is the platform-key rule. Move too much and the deployment breaks: `schema_version`
// under an org prefix leaves it looking unversioned, `__org__:acme` makes every organization stop
// resolving, the paid token rows make nobody able to log in. Move too little and the adopting
// organization silently loses data that was theirs — no error, no leak, the cemented failure at
// deployment scale, which is the thing this feature exists to prevent.
//
// So the rule is attacked from both sides: every platform key must stay, and every reserved key family
// the PRODUCT writes under an org prefix must move.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, isPlatformKey } from '../src/index.js';

/** Reserved keys that are platform state — moving any of these breaks the deployment. */
const PLATFORM = [
  '__org__:acme',              // registration records; moving it makes requireRegistration reject everyone
  '__agent_registry__:bot',    // "may this code-agent serve at all" — never a per-organization decision
  '__eeuser__:u1',             // paid user store
  '__eetoken__:t1',            // …and its tokens: move these and nobody can authenticate
  '__eeaudit__:a1',
  '__budget__:acme',           // set BY the operator, already keyed by organization
  '__policy__',
  '__pricing__',
];

/** Reserved keys that ARE an organization's data and must travel with it. */
const ADOPTABLE = ['__usage__:acme', '__metrics__:all', '__metrics__run:r1'];

  // The organization is REGISTERED first, because `adoptIntoOrg` refuses an unregistered id — a
  // one-keystroke typo would otherwise move every row under `org:<typo>:` and running it again with
  // the right name would fix nothing, since those rows now count as already-scoped. Registering here
  // rather than passing `allowUnregistered` keeps these tests on the path a real upgrade takes.
const seedRoot = async (s: InMemoryStorage, keys: string[], orgId = 'acme') => {
  for (const k of keys) await s.runs.put(k, { seeded: k });
  await s.runs.put(`__org__:${orgId}`, { id: orgId });
};

describe('the platform-key rule, from the side that breaks the deployment', () => {
  it.each(PLATFORM)('%s is classified as platform and left at the root', (key) => {
    expect(isPlatformKey(key),
      `${key} would be moved into an organization. Depending on which one, that ends as "no organization `
      + 'resolves" or "nobody can authenticate" — on the deployment being migrated, at the moment of '
      + 'migration.').toBe(true);
  });

  it.each(ADOPTABLE)('%s is classified as organization data', (key) => {
    expect(isPlatformKey(key), `${key} is the adopting organization's own data and would be left behind`).toBe(false);
  });

  it('an ordinary key is never mistaken for platform state', () => {
    for (const k of ['r-1:model:0', 'mem:t-1', 'anything']) expect(isPlatformKey(k)).toBe(false);
  });
});

/**
 * FINDING — two reserved key families that ARE organization data are classified as platform.
 *
 * `ADOPTABLE_RESERVED_PREFIXES` is `['__usage__', '__metrics__']`, described as the only reserved keys
 * ever seen written under an `org:<id>:` prefix. Measured against @gnldev/studio, driving its own routes
 * as an organization-bound admin on an org-scoped journal:
 *
 *   POST /workflows       -> org:acme:__studio_wf__wf1        (managed workflow definitions)
 *   POST /managed-agents  -> org:acme:__studio_agent__:bot    (managed agent versions)
 *
 * Both are written through the ALS-scoped reader — `rw.put(WF_STORE_PRE + …)` and the agent store's
 * `p(AGENT_STORE_PRE + …)` — so on a paid deployment they are per-organization by construction, and
 * `GET /workflows` / `GET /managed-agents` read them back through the same scope.
 *
 * On upgrade, a free deployment's managed workflows and promoted agent versions therefore stay at the
 * root, where nothing org-scoped will ever read them again. The definitions are not deleted; they
 * become unreachable, which is worse than an error because the operator sees an empty list and
 * concludes the upgrade simply did not carry them.
 *
 * The allow-list design is right — a forgotten DENY entry moves platform state, a forgotten ALLOW entry
 * only leaves data behind. These two are forgotten ALLOW entries.
 */
describe('managed workflow and agent stores are adopted, not left behind', () => {
  it.each([
    ['__studio_wf__wf1', 'managed workflow definitions'],
    ['__studio_agent__:bot', 'managed agent versions'],
  ])('%s (%s) is organization data, not platform state', (key) => {
    expect(isPlatformKey(key),
      'studio writes this key under `org:<id>:` on a paid deployment — measured through its own routes — '
      + 'so it is the adopting organization\'s data. Classified as platform, it stays at the root on '
      + 'upgrade and the organization silently loses it.')
      .toBe(false);
  });

  it('so adoption leaves them at the root', async () => {
    const s = new InMemoryStorage();
    await seedRoot(s, ['__studio_wf__wf1', '__studio_agent__:bot']);
    await s.adoptIntoOrg!('acme');

    const keys = await s.runs.listKeys!('');
    // SORTED before comparing: `listKeys` gives no order guarantee, and this case is about WHICH keys
    // moved, not the sequence a particular engine happens to enumerate them in.
    expect(keys.filter((k) => k.startsWith('org:acme:')).sort(),
      'the managed stores were left at the root — the organization sees an empty list after upgrading')
      .toEqual(['org:acme:__studio_agent__:bot', 'org:acme:__studio_wf__wf1']);
  });
});

describe('adoption moves what belongs to the organization and nothing else', () => {
  async function adopted() {
    const s = new InMemoryStorage();
    await seedRoot(s, [...PLATFORM, ...ADOPTABLE, 'r-1:model:0', 'r-1:outcome']);
    const result = await s.adoptIntoOrg!('acme');
    return { s, result, keys: await s.runs.listKeys!('') };
  }

  it('ordinary run data moves under the organization prefix', async () => {
    const { keys } = await adopted();
    expect(keys, 'the run did not move').toContain('org:acme:r-1:model:0');
    expect(keys, 'the original key was copied rather than moved').not.toContain('r-1:model:0');
  });

  it('every platform key is still at the root, unprefixed', async () => {
    const { keys } = await adopted();
    for (const k of PLATFORM) {
      expect(keys, `${k} was moved into the organization`).toContain(k);
      expect(keys, `${k} was ALSO written under the organization`).not.toContain(`org:acme:${k}`);
    }
  });

  // Reported as deduplicated FAMILIES (`__org__`, `__eetoken__`), not one line per row — which is the
  // right shape for an operator reading a migration report, and is asserted as such rather than as the
  // full key list I first assumed.
  it('and the result names them by family, so the operator can see the decision', async () => {
    const { result } = await adopted();
    const families = [...new Set(PLATFORM.map((k) => k.replace(/:.*$/, '')))].sort();

    expect(result.skippedPlatformKeys.sort(), 'the migration did not report what it declined to touch')
      .toEqual(families);
    expect(result.skippedPlatformKeys.length, 'the report lists one entry per ROW rather than per family')
      .toBeLessThan(PLATFORM.length + 1);
  });

  it('a dry run reports the same plan and changes nothing', async () => {
    const s = new InMemoryStorage();
    await seedRoot(s, [...PLATFORM, ...ADOPTABLE, 'r-1:model:0']);
    const before = (await s.runs.listKeys!('')).sort();

    const plan = await s.adoptIntoOrg!('acme', { dryRun: true });
    const after = (await s.runs.listKeys!('')).sort();
    const real = await s.adoptIntoOrg!('acme');

    expect(plan.dryRun).toBe(true);
    expect(after, 'a dry run modified the store').toEqual(before);
    expect(plan.moved, 'the dry run predicted a different plan from the one that ran').toEqual(real.moved);
  });
});

describe('running it twice', () => {
  it('moves nothing the second time', async () => {
    const s = new InMemoryStorage();
    await seedRoot(s, ['r-1:model:0', '__usage__:acme']);
    const first = await s.adoptIntoOrg!('acme');
    const second = await s.adoptIntoOrg!('acme');

    const total = (r: { moved: Record<string, number> }) => Object.values(r.moved).reduce((a, b) => a + b, 0);
    expect(total(first), 'the first run moved nothing — the test proves nothing').toBeGreaterThan(0);
    expect(total(second), 'a second run moved rows again — adoption is not idempotent').toBe(0);
    expect(second.alreadyScoped, 'the already-scoped rows were not recognised').toBeGreaterThan(0);
  });

  it('never nests one organization inside another', async () => {
    const s = new InMemoryStorage();
    await seedRoot(s, ['r-1:model:0']);
    await s.adoptIntoOrg!('acme');
    await s.adoptIntoOrg!('acme');
    await s.runs.put('__org__:globex', { id: 'globex' });
    await s.adoptIntoOrg!('globex'); // a second adoption, of an already-adopted store

    const keys = await s.runs.listKeys!('');
    expect(keys.filter((k) => /^org:[^:]+:org:/.test(k)),
      'a key was nested as org:a:org:b: — the second organization swallowed the first')
      .toEqual([]);
  });

  it('does not adopt another organization\'s rows into this one', async () => {
    const s = new InMemoryStorage();
    await s.runs.put('org:globex:r-g:model:0', { x: 1 });
    await s.runs.put('r-shared:model:0', { x: 1 });
    await s.runs.put('__org__:acme', { id: 'acme' });   // adoption refuses an unregistered organization
    await s.adoptIntoOrg!('acme');

    const keys = await s.runs.listKeys!('');
    expect(keys, 'globex\'s run was adopted into acme').toContain('org:globex:r-g:model:0');
    expect(keys, 'the unscoped run was not adopted').toContain('org:acme:r-shared:model:0');
  });
});

describe('the organization id is validated before anything moves', () => {
  it.each(['', 'a:b', 'org:x'])('%s is refused', async (bad) => {
    const s = new InMemoryStorage();
    await seedRoot(s, ['r-1:model:0']);
    await expect(s.adoptIntoOrg!(bad), `'${bad}' was accepted as an organization id`).rejects.toThrow();
    // `__org__:acme` is the registration row `seedRoot` writes; it is root-level platform state and
    // must be here untouched. What matters is that nothing gained a prefix.
    expect((await s.runs.listKeys!('')).sort(), 'rows moved before the id was rejected')
      .toEqual(['__org__:acme', 'r-1:model:0']);
  });
});
