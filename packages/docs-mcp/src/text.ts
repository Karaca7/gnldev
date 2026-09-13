// Produces human/LLM-readable text from the embedded static content (content.ts) — stays
// faithful to gnl.dev's llms.txt / llms-full.txt format, so the tool output doesn't look
// different in shape when the live fetch fails.
import { DEFAULT_DOCS_URL } from './docs-source.js';
import { FEATURES, FEATURES_BY_SLUG, OVERVIEW_DETAIL, OVERVIEW_SUMMARY, TIER_LABEL, EE_NOTE, type DocFeature } from './content.js';

/** gnl_docs_overview's embedded-content output: summary + ordered list of the features. */
export function buildOverviewText(docsUrl: string = DEFAULT_DOCS_URL): string {
  const lines: string[] = [];
  lines.push('# GNL');
  lines.push('');
  lines.push(`> ${OVERVIEW_SUMMARY}`);
  lines.push('');
  lines.push(OVERVIEW_DETAIL);
  lines.push('');
  // Derived, not typed in. The literal said 25 while FEATURES held 33 — and the CLI test asserted on
  // that same literal, so correcting the number would have turned a passing suite red. A count written
  // down twice drifts; a count written down once cannot.
  lines.push(`## Features (${FEATURES.length})`);
  lines.push('');
  for (const f of FEATURES) {
    lines.push(`${f.order}. [${f.title}](${docsUrl}/docs/${f.slug}) — ${f.oneLiner} (${TIER_LABEL[f.tier]}, \`${f.package}\`)`);
  }
  lines.push('');
  lines.push('Use gnl_docs_feature({ slug }) to see a feature\'s installation/API/example.');
  return lines.join('\n');
}

/** gnl_docs_feature's embedded-content output: full detail for a single feature. */
export function buildFeatureText(f: DocFeature, docsUrl: string = DEFAULT_DOCS_URL): string {
  const lines: string[] = [];
  lines.push(`## ${f.order}. ${f.title}`);
  lines.push('');
  lines.push(`- URL: ${docsUrl}/docs/${f.slug}`);
  lines.push(`- Tier: ${TIER_LABEL[f.tier]}`);
  lines.push(`- Package: \`${f.package}\``);
  lines.push(`- Summary: ${f.oneLiner}`);
  lines.push('');
  lines.push('### Installation / import');
  if (f.tier === 'ee') {
    lines.push(EE_NOTE);
    lines.push('');
  }
  lines.push('```ts');
  lines.push(f.install);
  lines.push('```');
  lines.push('');
  lines.push('### Core API');
  lines.push('');
  for (const api of f.apis) lines.push(`- ${api}`);
  lines.push('');
  lines.push('### Minimal example');
  lines.push('```ts');
  lines.push(f.example);
  lines.push('```');
  return lines.join('\n');
}

/**
 * Caps a value that is echoed back to the caller.
 *
 * What this server returns lands in an assistant's context window, so an argument that is repeated
 * verbatim is an amplifier: a 500 KB slug produced a 500 KB answer, measured. The echo is worth
 * keeping — it is how the model sees what it got wrong — but not at any length.
 */
export function echoed(value: string, max = 120): string {
  return value.length <= max ? value : `${value.slice(0, max)}… (${value.length} chars)`;
}

/** Error text for an unknown slug — also includes the list of valid slugs (so the LLM can easily self-correct). */
export function buildUnknownSlugText(slug: string): string {
  const valid = FEATURES.map((f) => f.slug).join(', ');
  return `Unknown slug: '${echoed(slug)}'. Valid slugs: ${valid}`;
}

export interface LocalSearchHit {
  slug: string;
  title: string;
  oneLiner: string;
  snippet: string;
}

/** Simple text search: case-insensitive substring across each feature's title/oneLiner/apis/install/example fields. */
export function searchLocal(query: string): LocalSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: LocalSearchHit[] = [];
  for (const f of FEATURES) {
    const haystacks = [f.title, f.oneLiner, f.package, ...f.apis, f.install, f.example];
    const matchLine = haystacks
      .join('\n')
      .split('\n')
      .find((line) => line.toLowerCase().includes(q));
    if (matchLine !== undefined) {
      hits.push({ slug: f.slug, title: f.title, oneLiner: f.oneLiner, snippet: matchLine.trim().slice(0, 200) });
    }
  }
  return hits;
}

export function buildSearchResultsText(query: string, hits: LocalSearchHit[]): string {
  if (hits.length === 0) {
    return `No results for '${echoed(query)}'. Call gnl_docs_overview() for the full list of features.`;
  }
  const lines: string[] = [];
  lines.push(`# Search: "${echoed(query)}" (${hits.length} results)`);
  lines.push('');
  for (const h of hits) {
    lines.push(`- [${h.slug}] ${h.title} — ${h.oneLiner}`);
    lines.push(`  match: ${h.snippet}`);
  }
  return lines.join('\n');
}

/** Runs the same simple substring search against the remote /llms-full.txt (section heading + matching line). */
export function searchRemoteFullText(query: string, llmsFullTxt: string): string {
  const q = query.trim().toLowerCase();
  if (!q) return buildSearchResultsText(query, []);
  const sections = llmsFullTxt.split(/\n---\n/);
  const lines: string[] = [];
  let count = 0;
  for (const section of sections) {
    const secLines = section.split('\n');
    const heading = secLines.find((l) => l.trim().startsWith('## '));
    const matchLine = secLines.find((l) => l.toLowerCase().includes(q));
    if (matchLine !== undefined) {
      count++;
      lines.push(`- ${heading?.replace(/^##\s*/, '') ?? '(?)'}`);
      lines.push(`  match: ${matchLine.trim().slice(0, 200)}`);
    }
  }
  if (count === 0) return `No results for '${echoed(query)}'. Call gnl_docs_overview() for the full list of features.`;
  return [`# Search: "${echoed(query)}" (${count} results)`, '', ...lines].join('\n');
}

export { FEATURES_BY_SLUG };
