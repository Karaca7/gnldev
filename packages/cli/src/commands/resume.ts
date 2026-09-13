// gnl resume <runId> --agent <name> — continue a suspended (or crashed mid-run) run live, using a
// registered agent's model/tools/guard. This is durability's "pays the bills" command: resumeRun
// self-contained reads the original input back from the journal (no need to re-supply the prompt).
import type * as Durable from '@gnldev/durable';
import type { Interrupt } from '@gnldev/durable';
import type { Command } from './types.js';
import { flag, flagBool, positional } from '../args.js';
import { loadConfig } from '../config.js';
import type { GnlDevConfig } from '../config.js';
import { getJournal } from '../journal-util.js';
import { loadDurable, projectDirOf } from '../runtime.js';
import { resolveAgentForResume, stepCountIs } from '../agent-resolve.js';
import { bold, colorStatus } from '../ansi.js';

export interface ResumeResultView {
  runId: string;
  agent: string;
  status: 'completed' | 'suspended';
  text?: string;
  interrupts: Interrupt[];
}

export async function resumeRunCore(
  config: GnlDevConfig,
  d: typeof Durable,
  runId: string,
  agentName: string,
  opts: { approvals?: Record<string, boolean> } = {},
): Promise<ResumeResultView> {
  const agentCfg = config.agents?.[agentName];
  if (!agentCfg) {
    const known = Object.keys(config.agents ?? {});
    throw new Error(`agent '${agentName}' not found in gnl.config (registered: ${known.length ? known.join(', ') : '(none)'})`);
  }
  const journal = getJournal(config, d);
  const { model, tools, guard, maxSteps } = await resolveAgentForResume(d, agentCfg, runId, journal);
  const result = await d.resumeRun(runId, { journal, model: model as any, tools, guard, stopWhen: stepCountIs(maxSteps), approvals: opts.approvals });
  return {
    runId,
    agent: agentName,
    status: result.interrupts.length > 0 ? 'suspended' : 'completed',
    text: (result as { text?: string }).text,
    interrupts: result.interrupts,
  };
}

export const resumeCommand: Command = {
  name: 'resume',
  group: 'operate',
  summary: 'Resume a suspended/crashed run with a registered agent',
  usage: 'gnl resume <runId> --agent <name> [--approve id1,id2] [--deny id3] [--json] [--config gnl.config.ts]',
  async run(ctx) {
    const runId = positional(ctx.argv, 0);
    if (!runId) throw new Error('runId required: gnl resume <runId> --agent <name>');
    const agentName = flag(ctx.argv, 'agent');
    if (!agentName) throw new Error('--agent required: gnl resume <runId> --agent <name>');
    const json = flagBool(ctx.argv, 'json');
    const configPath = flag(ctx.argv, 'config') ?? 'gnl.config.ts';
    // -approve/--deny: comma-separated toolCallIds for a suspended run's pending approval (Guard's
    // require-approval interrupts) — resumeRun's `approvals` map, keyed by toolCallId.
    const approvals: Record<string, boolean> = {};
    for (const id of (flag(ctx.argv, 'approve') ?? '').split(',').map((s) => s.trim()).filter(Boolean)) approvals[id] = true;
    for (const id of (flag(ctx.argv, 'deny') ?? '').split(',').map((s) => s.trim()).filter(Boolean)) approvals[id] = false;

    const config = await loadConfig(configPath);
    const d = await loadDurable(projectDirOf(configPath));
    const result = await resumeRunCore(config, d, runId, agentName, { approvals: Object.keys(approvals).length ? approvals : undefined });

    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`${bold(runId)}  →  ${colorStatus(result.status)}  (agent: ${result.agent})`);
    if (result.text) console.log(`  ${result.text}`);
    if (result.interrupts.length > 0) {
      console.log(`  awaiting approval: ${result.interrupts.map((i) => `${i.toolName}[${i.toolCallId}]`).join(', ')}`);
    }
  },
};
