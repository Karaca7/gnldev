// Agent approval registry — the governance gate for CODE-defined agents. Without it, an agent added to
// `createGnl({ agents })` is live the moment the server restarts: no admin ever approves that it may
// serve production traffic. This registry closes that gap — each agent is recorded on boot and must be
// APPROVED (platform-admin, via Studio) before it serves; an already-approved agent whose CONFIG DRIFTS
// (new tools / different model / changed system) flips back to `changed` and needs re-approval, so an
// approved agent's behavior can't be silently altered. Opt-in at the server (requireAgentApproval) —
// existing deployments are byte-for-byte unchanged until they turn it on.
//
// Journal-backed, root-level (`__agent_registry__:<name>`): approval is a PLATFORM decision (should this
// code-agent serve AT ALL), not per-org — an agent's per-org visibility is a separate axis
// (agentVisibleToOrg). withOrg still prefixes it if used through an org view, but the canonical registry
// lives at the root (platform-admin surface), same as `__audit__`.
import type { Journal } from './journal.js';
import { argsHash } from './hash.js';
import type { AgentConfig } from './registry.js';

/** Registry key for an agent's approval record. Root-level, not runId-scoped (invisible to parseJournalKey). */
export const AGENT_REGISTRY_PRE = '__agent_registry__:';
export function agentRegistryKey(name: string): string {
  return `${AGENT_REGISTRY_PRE}${name}`;
}

export type AgentApprovalStatus =
  /** Newly seen — awaiting a platform-admin decision. NOT servable. */
  | 'pending'
  /** Approved AND its config fingerprint still matches → servable. */
  | 'approved'
  /** Was approved but its config DRIFTED (fingerprint changed) → NOT servable until re-approved. */
  | 'changed'
  /** Explicitly blocked by an admin → NOT servable. */
  | 'blocked';

/** One agent's approval record. */
export interface AgentRegistryRecord {
  name: string;
  status: AgentApprovalStatus;
  /** Fingerprint of the CURRENTLY-seen config (recomputed every boot). For `changed`, this is the NEW
   *  (drifted) fingerprint; the last-approved one lives in `approvedFingerprint`. */
  fingerprint: string;
  /** The fingerprint that was approved (set on approve) — drift = `fingerprint !== approvedFingerprint`. */
  approvedFingerprint?: string;
  firstSeenAt: number;
  updatedAt: number;
  approvedBy?: string;
  approvedAt?: number;
  /** Optional admin note (e.g. block reason). */
  note?: string;
}

/**
 * Stable fingerprint of an agent's config SHAPE — captures what the agent IS so a meaningful change
 * (new tools, different model, changed system prompt, added sub-agents) is detected and re-triggers
 * approval. DynamicArg fields (model/tools/system given as FUNCTIONS) can't be hashed meaningfully, so
 * they contribute a stable `dyn` marker — the fingerprint still changes if you switch a field between
 * static and dynamic, but two runs of the same dynamic config match (deterministic).
 */
export function fingerprintAgent(name: string, cfg: AgentConfig): string {
  const model =
    typeof cfg.model === 'function' ? 'dyn'
      : Array.isArray(cfg.model) ? cfg.model.map((m) => (typeof m === 'string' ? m : 'model')).join('|')
        : typeof cfg.model === 'string' ? cfg.model : 'model';
  const tools =
    typeof cfg.tools === 'function' ? 'dyn'
      : cfg.tools ? Object.keys(cfg.tools).sort().join(',') : '';
  const system =
    typeof cfg.system === 'function' ? 'dyn'
      : typeof cfg.system === 'string' ? cfg.system : '';
  return argsHash({
    name,
    model,
    tools,
    system,
    guard: cfg.guard ? 1 : 0,
    maxSteps: cfg.maxSteps ?? null,
    agents: cfg.agents ? [...cfg.agents].sort() : [],
    processors: cfg.processors?.map((p) => p.name).sort() ?? [],
  });
}

/**
 * Records an agent into the registry (idempotent — call on every boot). First sight → `pending`. If a
 * record exists: an APPROVED agent whose fingerprint DRIFTED flips to `changed` (re-approval required);
 * everything else keeps its status (approved-and-matching stays servable; pending/blocked/changed
 * untouched). Returns the resulting record. Get→put is sufficient (advisory governance state, not an
 * exactly-once ledger); a concurrent double-boot just writes the same value.
 */
export async function recordAgent(journal: Journal, name: string, fingerprint: string): Promise<AgentRegistryRecord> {
  const key = agentRegistryKey(name);
  const now = Date.now();
  const existing = await journal.get<AgentRegistryRecord>(key);
  if (!existing) {
    const rec: AgentRegistryRecord = { name, status: 'pending', fingerprint, firstSeenAt: now, updatedAt: now };
    await journal.put(key, rec);
    return rec;
  }
  // Approved but the config drifted → re-approval required.
  if (existing.status === 'approved' && existing.approvedFingerprint !== fingerprint) {
    const rec: AgentRegistryRecord = { ...existing, status: 'changed', fingerprint, updatedAt: now };
    await journal.put(key, rec);
    return rec;
  }
  // Otherwise keep the status; refresh the currently-seen fingerprint (cheap, keeps the record honest).
  if (existing.fingerprint !== fingerprint) {
    const rec: AgentRegistryRecord = { ...existing, fingerprint, updatedAt: now };
    await journal.put(key, rec);
    return rec;
  }
  return existing;
}

/** Approve an agent — status `approved`, pinning the CURRENT fingerprint (later drift re-triggers). */
export async function approveAgent(journal: Journal, name: string, by: string, note?: string): Promise<AgentRegistryRecord> {
  const key = agentRegistryKey(name);
  const now = Date.now();
  const existing = await journal.get<AgentRegistryRecord>(key);
  const base: AgentRegistryRecord = existing ?? { name, status: 'pending', fingerprint: '', firstSeenAt: now, updatedAt: now };
  const rec: AgentRegistryRecord = {
    ...base,
    status: 'approved',
    approvedFingerprint: base.fingerprint,
    approvedBy: by,
    approvedAt: now,
    updatedAt: now,
    ...(note !== undefined ? { note } : {}),
  };
  await journal.put(key, rec);
  return rec;
}

/** Block an agent — status `blocked` (not servable regardless of fingerprint). */
export async function blockAgent(journal: Journal, name: string, by: string, note?: string): Promise<AgentRegistryRecord> {
  const key = agentRegistryKey(name);
  const now = Date.now();
  const existing = await journal.get<AgentRegistryRecord>(key);
  const base: AgentRegistryRecord = existing ?? { name, status: 'pending', fingerprint: '', firstSeenAt: now, updatedAt: now };
  const rec: AgentRegistryRecord = { ...base, status: 'blocked', approvedBy: by, updatedAt: now, ...(note !== undefined ? { note } : {}) };
  await journal.put(key, rec);
  return rec;
}

/** Reads one agent's registry record (undefined if never recorded). */
export async function agentApprovalStatus(journal: Journal, name: string): Promise<AgentRegistryRecord | undefined> {
  return journal.get<AgentRegistryRecord>(agentRegistryKey(name));
}

/**
 * Whether an agent may serve — true ONLY when `status === 'approved'`. An unrecorded agent (no registry
 * entry at all) returns `false` under the approval regime — but callers gate this behind an opt-in flag
 * so unrecorded agents in a NON-approval deployment are unaffected (see the server's requireAgentApproval).
 */
export async function isAgentServable(journal: Journal, name: string): Promise<boolean> {
  const rec = await agentApprovalStatus(journal, name);
  return rec?.status === 'approved';
}

/** Lists every agent registry record (requires `listKeys`; throws a clear error otherwise). */
export async function listAgentRegistry(journal: Journal): Promise<AgentRegistryRecord[]> {
  if (typeof journal.listKeys !== 'function') {
    throw new Error('@gnldev/durable: listAgentRegistry requires the journal to implement `listKeys` (see the Journal interface) — cannot enumerate the registry without it.');
  }
  const keys = await journal.listKeys(AGENT_REGISTRY_PRE);
  const out: AgentRegistryRecord[] = [];
  for (const k of keys) {
    const rec = await journal.get<AgentRegistryRecord>(k);
    if (rec) out.push(rec);
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}
