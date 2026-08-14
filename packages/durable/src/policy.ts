// Data-driven guard: policy rules live in the journal (editable from Studio),
// PolicyGuard reads them LIVE on every call and turns them into a Guard decision → a rule change
// Doesn't require a deploy. Since the document is small, simplicity without caching was preferred.
import type { Journal } from './journal.js';
import type { Guard, GuardDecision } from './guard.js';

export interface PolicyRule {
  /** Tool name (exact match) or '*' (all). Exact match is evaluated BEFORE the wildcard. */
  tool: string;
  action: 'allow' | 'deny' | 'require-approval';
  reason?: string;
}

/** The policy document in the journal: every write increments the version number (full history via audit). */
export interface PolicyDoc {
  version: number;
  rules: PolicyRule[];
  updatedAt?: number;
}

/** The journal key of the policy document — invisible to parseJournalKey. */
export const POLICY_KEY = '__policy__';

/** Rule evaluation (pure): exact tool match first, then the '*' wildcard; falls back if no match. */
export function evaluatePolicy(
  doc: PolicyDoc | undefined,
  toolName: string,
  fallback: GuardDecision['action'] = 'allow',
): GuardDecision {
  const rules = doc?.rules ?? [];
  const rule = rules.find((r) => r.tool === toolName) ?? rules.find((r) => r.tool === '*');
  const action = rule?.action ?? fallback;
  if (action === 'allow') return { action: 'allow' };
  return { action, reason: rule?.reason } as GuardDecision;
}

/**
 * A Guard that applies the policy document from the journal. If there's no rule, `fallback` (default
 * 'allow') applies — i.e. behavior is unchanged while policyGuard is wired in but the document is
 * Empty; rules take effect immediately (on the next tool call) as they're added from Studio.
 */
export function policyGuard(journal: Journal, opts: { key?: string; fallback?: GuardDecision['action'] } = {}): Guard {
  const key = opts.key ?? POLICY_KEY;
  return async ({ toolName }) => {
    const doc = await journal.get<PolicyDoc>(key);
    return evaluatePolicy(doc, toolName, opts.fallback);
  };
}
