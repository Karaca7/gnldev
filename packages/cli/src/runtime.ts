// Runtime resolver: @gnl/cli ships ~zero sert runtime bağımlılığı. Komutlar (`gnl runs`, `gnl dev`, …)
// @gnl/durable/server/studio/memory/auth ve hono/@hono/node-server'ı KENDİ node_modules'ından değil,
// üzerinde çalıştığı PROJENİN node_modules'ından çözer — `npx @gnl/cli init` koca runtime'ı indirmez,
// ve komutlar her zaman projenin yüklü sürümüyle çalışır (CLI ↔ proje arasında sürüm çakışması yok).
//
// Çözümleme kökü: gnl.config'in bulunduğu dizin (projectDirOf). Node'un kendi modül çözümleme
// algoritması (createRequire + require.resolve), tıpkı gnl.config.ts içindeki `import '@gnl/durable'`
// satırının izleyeceği node_modules üst-dizin taramasının AYNISINI izler — bu yüzden hem loadConfig'in
// gnl.config.ts'yi dinamik import etmesi HEM DE loadDurable(dir) AYNI çözümlenmiş dosyaya (aynı
// file:// URL'ine) varır, ve Node'un ESM modül önbelleği (resolved URL'e göre anahtarlanır) bu ikisine
// AYNI modül örneğini döndürür. Bu, doğruluk açısından kritik: bir journal nesnesi projenin
// `@gnl/durable`'ıyla kuruluyorsa, üzerinde çalışan fonksiyonlar (forkRun/reconstructState/…) da AYNI
// örnekten gelmeli — iki farklı @gnl/durable kopyası aynı journal'ı işlemsel olarak uyumsuz kılar.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

// `import type` — derleme zamanında tam tip kontrolü sağlar, tsc tarafından silinir → runtime
// bağımlılığı DEĞİLDİR (bu paketler @gnl/cli'nin peerDependencies + devDependencies'inde durur).
import type * as Durable from '@gnl/durable';
import type * as Server from '@gnl/server';
import type * as Studio from '@gnl/studio';
import type * as StudioAi from '@gnl/studio/ai';
import type * as Memory from '@gnl/memory';
import type * as Auth from '@gnl/auth';
import type * as HonoNs from 'hono';
import type * as NodeServer from '@hono/node-server';

/** gnl.config'in bulunduğu dizin = çözümleme kökü (`dirname(resolve(configPath))`). */
export function projectDirOf(configPath: string): string {
  return dirname(resolve(configPath));
}

/** Resolves `spec` from `projectDir` (require.resolve semantics) + the actual imported module. */
async function resolveModuleFromProject(spec: string, projectDir: string): Promise<{ mod: Record<string, unknown>; resolvedFile: string }> {
  const req = createRequire(join(projectDir, 'noop.js'));
  let resolved: string;
  try {
    resolved = req.resolve(spec);
  } catch {
    throw new Error(
      `gnl: couldn't resolve '${spec}' from ${projectDir} — run this inside a gnl project that has it installed (e.g. \`npm i ${spec}\`).`,
    );
  }
  const mod = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
  return { mod, resolvedFile: resolved };
}

/**
 * `spec`'i `projectDir`'in node_modules'ından çözer + dinamik import eder (@gnl/cli'nin KENDİ
 * bağımlılıklarından DEĞİL). Bulunamazsa net, eyleme geçirilebilir bir hata fırlatır.
 */
export async function resolveFromProject(spec: string, projectDir: string): Promise<unknown> {
  return (await resolveModuleFromProject(spec, projectDir)).mod;
}

// --- Uyum guard'ı (şekil/capability + sürüm) ------------------------------------------------------
// CLI runtime'ı projeden çözünce, çekirdek CLI'nin beklediğinden ESKİ/UYUMSUZ olabilir (örn. yeni CLI
// + eski @gnl/durable → CLI'nin çağırdığı bir export yok → çıplak "X is not a function" TypeError).
// Bunu net bir hataya çeviriyoruz: (1) ŞEKİL kontrolü — CLI'nin GERÇEKTEN çağırdığı export'lar mod'da
// fonksiyon olarak var mı (sürümden bağımsız, iki yönü de yakalar: eski çekirdek eksik export, YA DA
// yeni çekirdek bir export'u kaldırmış); (2) SÜRÜM kontrolü — package.json'daki version, CLI'nin
// minimumunun altındaysa net bir "upgrade" mesajı. Zero-dep: semver paketi yok, elle major.minor.patch
// karşılaştırması (prerelease/build metadata yok sayılır).

export const REQUIRED_DURABLE_EXPORTS = [
  'forkRun',
  'reconstructState',
  'toJournal',
  'getRunCost',
  'summarizeRun',
  'sweepRuns',
  'purgeRun',
  'resumeRun',
  'createGnl',
  'resolveModel',
  'withModelFallback',
] as const;
export const REQUIRED_SERVER_EXPORTS = ['createRestApi'] as const;
export const REQUIRED_STUDIO_EXPORTS = ['createStudioApp', 'createStudioRunner'] as const;

// Henüz her paket 0.0.0'da (yayın öncesi) — false-positive üretmemek için taban şimdilik '0.0.0'.
// Yayınla birlikte (ilk gerçek minor/major) bunları CLI'nin fiilen ihtiyaç duyduğu en düşük sürüme
// bump'la; mekanizma (assertCompatible/gte) zaten yerinde ve test edilmiş durumda.
const MIN_DURABLE = '0.0.0';
const MIN_SERVER = '0.0.0';
const MIN_STUDIO = '0.0.0';

/** Zero-dep semver `>=`: yalnız major.minor.patch'i sayısal karşılaştırır, prerelease/build yok sayılır. */
export function gte(version: string, min: string): boolean {
  const parse = (v: string): [number, number, number] => {
    const core = v.split('-')[0]!.split('+')[0]!;
    const [maj, min_, pat] = core.split('.');
    return [Number(maj) || 0, Number(min_) || 0, Number(pat) || 0];
  };
  const [va, vb, vc] = parse(version);
  const [ma, mb, mc] = parse(min);
  if (va !== ma) return va > ma;
  if (vb !== mb) return vb > mb;
  return vc >= mc;
}

/** Walks up from `resolvedEntryFile` looking for the package.json with `name === pkgName`
 *  (the package root — node_modules/<pkgName>/package.json). '0.0.0' if not found (unresolved version
 *  is treated as "don't know", not as a hard failure — the capability check still guards correctness). */
function findPackageVersion(resolvedEntryFile: string, pkgName: string): string {
  let dir = dirname(resolvedEntryFile);
  for (let i = 0; i < 8; i++) {
    const pj = join(dir, 'package.json');
    if (existsSync(pj)) {
      try {
        const json = JSON.parse(readFileSync(pj, 'utf8')) as { name?: string; version?: string };
        if (json.name === pkgName) return json.version ?? '0.0.0';
      } catch {
        // malformed package.json at this level — keep walking up.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0';
}

/**
 * Throws a clear, actionable error if `mod` (already-imported) is version-too-old or missing an
 * export the CLI actually calls. Exported for direct unit testing (see runtime.test.ts).
 */
export function assertCompatible(
  mod: Record<string, unknown>,
  spec: string,
  projectDir: string,
  resolvedFile: string,
  required: readonly string[],
  minVersion: string,
): void {
  const version = findPackageVersion(resolvedFile, spec);
  if (!gte(version, minVersion)) {
    throw new Error(
      `gnl CLI needs ${spec} >= ${minVersion}, but this project (${projectDir}) has ${version} — upgrade with \`npm i ${spec}@latest\`.`,
    );
  }
  const missing = required.filter((name) => typeof mod[name] !== 'function');
  if (missing.length > 0) {
    throw new Error(
      `gnl: the ${spec} in this project (v${version}) is missing: ${missing.join(', ')} — it's incompatible with this gnl CLI (needs >= ${minVersion}). Upgrade with \`npm i ${spec}@latest\`, or use a matching gnl CLI version.`,
    );
  }
}

/** Projenin @gnl/durable'ı — forkRun/reconstructState/toJournal/getRunCost/summarizeRun/sweepRuns/… */
export async function loadDurable(projectDir: string): Promise<typeof Durable> {
  const { mod, resolvedFile } = await resolveModuleFromProject('@gnl/durable', projectDir);
  assertCompatible(mod, '@gnl/durable', projectDir, resolvedFile, REQUIRED_DURABLE_EXPORTS, MIN_DURABLE);
  return mod as unknown as typeof Durable;
}

/** Projenin @gnl/server'ı — createRestApi. */
export async function loadServer(projectDir: string): Promise<typeof Server> {
  const { mod, resolvedFile } = await resolveModuleFromProject('@gnl/server', projectDir);
  assertCompatible(mod, '@gnl/server', projectDir, resolvedFile, REQUIRED_SERVER_EXPORTS, MIN_SERVER);
  return mod as unknown as typeof Server;
}

/** Projenin @gnl/studio'su — createStudioApp/createStudioRunner. */
export async function loadStudio(projectDir: string): Promise<typeof Studio> {
  const { mod, resolvedFile } = await resolveModuleFromProject('@gnl/studio', projectDir);
  assertCompatible(mod, '@gnl/studio', projectDir, resolvedFile, REQUIRED_STUDIO_EXPORTS, MIN_STUDIO);
  return mod as unknown as typeof Studio;
}

/** Projenin @gnl/studio/ai'ı — aiToolSchema. */
export async function loadStudioAi(projectDir: string): Promise<typeof StudioAi> {
  return (await resolveFromProject('@gnl/studio/ai', projectDir)) as typeof StudioAi;
}

/** Projenin @gnl/memory'si — memoryPreset (dev studio/playground varsayılan hafızası, opsiyonel). */
export async function loadMemory(projectDir: string): Promise<typeof Memory> {
  return (await resolveFromProject('@gnl/memory', projectDir)) as typeof Memory;
}

/** Projenin @gnl/auth'u — roleAuth (opt-in rol tabanlı REST + Studio auth). */
export async function loadAuth(projectDir: string): Promise<typeof Auth> {
  return (await resolveFromProject('@gnl/auth', projectDir)) as typeof Auth;
}

/** Projenin hono'su — Hono (dev server app gövdesi). */
export async function loadHono(projectDir: string): Promise<typeof HonoNs> {
  return (await resolveFromProject('hono', projectDir)) as typeof HonoNs;
}

/** Projenin @hono/node-server'ı — serve (Node HTTP boot). */
export async function loadNodeServer(projectDir: string): Promise<typeof NodeServer> {
  return (await resolveFromProject('@hono/node-server', projectDir)) as typeof NodeServer;
}
