// GOREV W2 — MCP FIREWALL. Market evidence: 30 CVEs in 60 days, tool-poisoning, rug-pull — MCP tools:
// their DEFINITIONS (description/inputSchema) are untrusted data coming from the server. `@gnldev/durable`'s
// Guard contract is already pluggable (see guard.ts, policy.ts) — this file, WITHOUT TOUCHING `durable`,
// produces an MCP-specific Guard: allowlist/denylist + description-pinning (rug-pull defense) + per-tool limit.
import { claim } from '@gnldev/durable';
import type { Guard, GuardCall, GuardDecision, Journal, JournalReader } from '@gnldev/durable';
import type { McpToolSummary } from './index.js';

/** Journal key for the pinned description hash — invisible to parseJournalKey (not a model/tool). */
export function mcpPinKey(server: string, toolName: string): string {
  return `__mcp_pin__:${server}:${toolName}`;
}

/** Pinned record: the description+inputSchema hash claimed the FIRST TIME a tool is SEEN. */
export interface McpPinRecord {
  descriptionHash: string;
  pinnedAt: number;
}

export interface McpFirewallOptions {
  /** This MCP server's identity — distinguishes the pin key (multiple servers can share the same journal). */
  server: string;
  /** Journal for the pin + per-tool counter (usually the SAME journal you pass to `runDurable`). */
  journal: Journal;
  /**
   * A LIVE summary of the discovered tools — e.g. `await handle.describeTools()`. Description pinning
   * uses this: on every guard call, `toolName`'s CURRENT description/inputSchema hash is read from here
   * (what the server "currently says" — this is exactly what we want to pin, compared against the pinned one).
   */
  tools: ReadonlyArray<McpToolSummary>;
  /** Allow ONLY this/these name(s)/pattern(s). If given, FAIL-CLOSED: EVERY tool not on the list is denied. */
  allow?: ReadonlyArray<string | RegExp>;
  /** Deny this/these name(s)/pattern(s) (evaluated AFTER allow). */
  deny?: ReadonlyArray<string | RegExp>;
  /** Per-tool count of SUCCESSFUL calls allowed within a run — once exceeded, 'require-approval'. */
  maxCallsPerRun?: number;
}

function matches(name: string, patterns: ReadonlyArray<string | RegExp> | undefined): boolean {
  if (!patterns) return false;
  return patterns.some((p) => (typeof p === 'string' ? p === name : p.test(name)));
}

/**
 * Produces a Guard specific to MCP tools. Conforms 1:1 to the existing Guard contract
 * (allow/deny/require-approval) — can be passed directly to `runDurable({ guard })` or chained with
 * another Guard (e.g. `policyGuard`) via `composeGuards`.
 *
 *  1. ALLOWLIST/DENYLIST: if `allow` is not given, fail-open (every tool is free, only `deny` applies);
 *     if `allow` is given, FAIL-CLOSED (every tool not on the list is denied). `deny` is evaluated
 *     AFTER `allow` (if both match, deny wins).
 *
 *  2. DESCRIPTION PINNING (tool-poisoning/rug-pull defense): a tool's description+inputSchema
 *     hash (`McpToolSummary.descriptionHash`) is WRITTEN to the journal via `claim()` the FIRST TIME
 *     it is SEEN (key: `__mcp_pin__:<server>:<tool>`) — the winning call is the PERMANENT pin for that
 *     run/journal. On EVERY subsequent guard call, the current hash from `opts.tools` is compared
 *     against the pin; if the hash HAS CHANGED (the server sneakily changed the description — rug-pull)
 *     it returns 'require-approval' + a reason message ("tool description changed — poisoning risk") —
 *     the tool WILL NOT RUN without human approval. Since the pin lives in the journal, it stays
 *     STABLE across resume/replay (same journal → same decision).
 *
 *  3. maxCallsPerRun: if the per-tool count of SUCCESSFUL (`status:'succeeded'`) calls in the journal
 *     REACHES this limit, the next call stops with 'require-approval' (similar to limits.ts's
 *     `maxToolCalls` pattern, but per-tool; if the journal doesn't support `readRun`, fail-open — if it
 *     can't be counted, it isn't blocked).
 */
export function mcpFirewall(opts: McpFirewallOptions): Guard {
  const { server, journal, allow, deny, maxCallsPerRun } = opts;

  return async (call: GuardCall): Promise<GuardDecision> => {
    const { toolName, runId } = call;

    // 1) Allow/deny patterns.
    if (allow && allow.length > 0 && !matches(toolName, allow)) {
      return { action: 'deny', reason: `mcpFirewall: '${toolName}' is not in the allowlist` };
    }
    if (matches(toolName, deny)) {
      return { action: 'deny', reason: `mcpFirewall: '${toolName}' is in the denylist` };
    }

    // 2) Description pinning — tool-poisoning/rug-pull defense.
    const current = opts.tools.find((t) => t.name === toolName);
    if (current) {
      const pinKey = mcpPinKey(server, toolName);
      const won = await claim(journal, pinKey, { descriptionHash: current.descriptionHash, pinnedAt: Date.now() } satisfies McpPinRecord);
      if (!won) {
        const pinned = await journal.get<McpPinRecord>(pinKey);
        if (pinned && pinned.descriptionHash !== current.descriptionHash) {
          return {
            action: 'require-approval',
            reason: `mcpFirewall: '${toolName}' tool description changed — poisoning risk (pinned: ${pinned.descriptionHash}, current: ${current.descriptionHash})`,
          };
        }
      }
    }

    // 3) maxCallsPerRun — per-tool count of SUCCESSFUL calls (if the journal supports readRun).
    if (maxCallsPerRun != null) {
      const reader = journal as Partial<JournalReader>;
      if (typeof reader.readRun === 'function') {
        const entries = await reader.readRun(runId);
        let count = 0;
        for (const e of entries) {
          if (e.kind !== 'tool') continue;
          const v = e.value as any;
          if (v?.status === 'succeeded' && v?.toolName === toolName) count++;
        }
        if (count >= maxCallsPerRun) {
          return {
            action: 'require-approval',
            reason: `mcpFirewall: '${toolName}' reached the per-run call limit (${count}/${maxCallsPerRun})`,
          };
        }
      }
    }

    return { action: 'allow' };
  };
}

/**
 * Chains two Guards: `first` runs FIRST; if it returns `'allow'`, `second` runs (e.g. `mcpFirewall`
 * first, then `policyGuard`). If `first` returns `deny`/`require-approval`, `second` is NEVER called
 * (short-circuit — the firewall's denial comes before the policy).
 */
export function composeGuards(first: Guard, second: Guard): Guard {
  return async (call: GuardCall): Promise<GuardDecision> => {
    const decision = await first(call);
    if (decision.action !== 'allow') return decision;
    return second(call);
  };
}
