import { nestedAgentRunId } from './journal.js';
import { tool, stepCountIs } from 'ai';
import type { Tool } from 'ai';
import { z } from 'zod';
import { runDurable } from './run.js';
import { readRunTaint, markRunTainted } from './taint.js';
import type { Journal } from './journal.js';
import type { Guard, Interrupt } from './guard.js';
import type { ModelInput, ToolSet } from './types.js';
import type { RunLimits } from './limits.js';

/**
 * carry taint across the sub-agent runId boundary. Taint is keyed per-run, so a nested run
 * (`agent:${toolCallId}`) starts CLEAN even when its parent is tainted — a side effect inside the
 * sub-agent would then bypass the parent's `taintedSideEffects` ladder. If the parent is tainted at the
 * moment it spawns the sub-agent, mark the nested run tainted BEFORE it executes any tools, preserving
 * the ORIGINAL provenance and noting it was inherited. Only-stricter / fail-safe: an un-tainted parent
 * (or an unknown parentRunId) changes nothing. First-wins/idempotent, so a resume re-marks harmlessly.
 */
async function inheritParentTaint(journal: Journal, parentRunId: string | undefined, nestedRunId: string): Promise<void> {
  if (!parentRunId) return;
  const parentTaint = await readRunTaint(journal, parentRunId);
  if (!parentTaint) return;
  await markRunTainted(journal, nestedRunId, {
    toolCallId: parentTaint.toolCallId,
    toolName: parentTaint.toolName,
    source: parentTaint.source,
    reason: `inherited from tainted parent run '${parentRunId}'${parentTaint.reason ? `: ${parentTaint.reason}` : ''}`,
  });
}

export interface AgentToolConfig {
  journal: Journal;
  /** A model OR a factory that produces a model from the nested runId (to freeze the registry fallback chain onto the nested run). */
  model: ModelInput | ((nestedRunId: string) => unknown | Promise<unknown>);
  tools?: ToolSet;
  system?: string;
  guard?: Guard;
  maxSteps?: number;
  /**
   * TASK W1 fan-out inheritance: the parent's `limits` is passed to the sub-agent AS-IS → the sub-agent
   * independently bounds its own execution against this same ceiling too (prevents a single sub-agent
   * from spending without limit on its own). Also, the parent's OWN limit check (`limits.ts`
   * `scopedUsage`) RECURSIVELY sums this sub-agent's (nested `runId = agent:${toolCallId}`) usage in the
   * journal too → the total (parent + all sub-agents) can NEVER bypass the parent's ceiling.
   */
  limits?: RunLimits;
  /**
   * WHOSE work the delegation is, carried into the nested run.
   *
   * Taint was forwarded here from the start; identity was not. So "delegate" quietly meant "drop the
   * protection layer": with no `resourceId` the nested run builds no cross-channel identity plan
   * (durable-tool's XID/`semanticIdentity` both require it), its `:input` records no owner — so
   * `ownershipDenied` passes on the `!owner` branch, the actor lock never fires, and
   * `purgeResource` cannot find that run when the person asks to be deleted.
   *
   * The asymmetry was the tell: the parent's taint, limits and tool policy all crossed the boundary
   * because each was noticed once. Identity was never noticed, and a sub-agent is not a different
   * person — it is the same request, one frame deeper.
   */
  resourceId?: string;
  /** The conversation the delegation belongs to — same reason as `resourceId`. */
  threadId?: string;
  /** The verified caller identity (ownership lock). Inherited, never invented. */
  actor?: string;
  /** Where the work came in from — kept so a nested run's channel is not silently 'unknown'. */
  channel?: string;
  /** FAZ-4 K12: the parent's tool policy, inherited AS-IS — registry.ts's JSDoc promised this for
   *  Years while nothing forwarded it; under 'strict-critical' a delegated sub-agent's undeclared
   *  Side-effect tool must not be the hole in the fence. */
  toolPolicy?: 'strict' | 'strict-critical';
  /** require-approval decisions (passed to the nested run) — approvals flow from here during a network resume. */
  approvals?: Record<string, boolean>;
  /**
   * The runId of the parent that spawned this sub-agent. When the parent is tainted, its taint
   * is carried into the nested run so the sub-agent's side effects go through the SAME `taintedSideEffects`
   * ladder. The agent-as-tool path (`createAgentTool`) reads this per-call from `options.parentRunId`; the
   * network path (`runNetwork` → `runSubAgent`) passes the router's runId here.
   */
  parentRunId?: string;
}

/**
 * The SINGLE source of sub-agent call semantics: run durably under the nested runId, return {text, interrupts}.
 * BOTH `createAgentTool` (static agent-as-tool) AND the registry's `runNetwork` (dynamic network) call
 * THIS — model resolution / maxSteps default / limits inheritance live in one place, the paths cannot silently diverge.
 */
export async function runSubAgent(
  config: AgentToolConfig,
  task: string,
  nestedRunId: string,
): Promise<{ text: string; interrupts: Interrupt[] }> {
  const model = typeof config.model === 'function' ? await config.model(nestedRunId) : config.model;
  // Carry the parent's taint into the nested run BEFORE it executes any tools.
  await inheritParentTaint(config.journal, config.parentRunId, nestedRunId);
  const res = await runDurable({
    runId: nestedRunId,
    journal: config.journal,
    model,
    tools: config.tools,
    system: config.system,
    guard: config.guard,
    approvals: config.approvals,
    prompt: task,
    stopWhen: stepCountIs(config.maxSteps ?? 8),
    limits: config.limits,
    // KİMLİK DEVRİ — taint'in geçtiği sınırdan kimliğin de geçmesi. Yoksa alt koşum sahipsiz doğar
    // ve sahipsizlik kalıcıdır (`:input` ilk yazan kazanır).
    ...(config.resourceId ? { resourceId: config.resourceId } : {}),
    ...(config.threadId ? { threadId: config.threadId } : {}),
    ...(config.actor ? { actor: config.actor } : {}),
    ...(config.channel ? { channel: config.channel } : {}),
    ...(config.toolPolicy ? { toolPolicy: config.toolPolicy } : {}),
  } as any);
  return { text: res.text, interrupts: res.interrupts };
}

/**
 * Turns a sub-agent into an AI SDK tool → "agent-as-tool" for multi-agent setups.
 * Its execute runs a nested `runDurable` (nested runId = `agent:${toolCallId}`, the SAME journal).
 *
 * **Moat synergy (two levels of durability):** When used inside a parent `runDurable`, the parent's
 * `durableTool` memoizes this agent-tool's result → the ENTIRE sub-agent is SKIPPED on a parent resume
 * (exactly-once handoff). If the sub-agent crashes midway, it resumes from its own journal.
 */
export function createAgentTool(
  config: AgentToolConfig,
  opts?: { description?: string },
// The return type is DECLARED, not inferred. Left to inference, TypeScript emits a .d.ts that names
// a pnpm-internal path inside @ai-sdk/provider-utils — a package we do not declare and should not
// have to (TS2742). Naming the contract in types reachable through `ai`, the peer we already
// require, keeps our published surface ours and our dependency list honest.
): Tool<{ task: string }, { text: string; interrupts: Interrupt[] }> & { idempotent: boolean } {
  // H7: the nested run is ITSELF durable → a repeated call replays from its own journal, produces
  // no side effect → idempotent (smooth resume without getting stuck at the crash-window gate).
  return Object.assign(tool({
    description: opts?.description ?? 'Delegate a task to an expert sub-agent',
    inputSchema: z.object({ task: z.string().describe('the task/question to give the sub-agent') }),
    execute: async ({ task }, options: any) => {
      // Ebeveynin insan cevapları — durable-tool bunları `gnlApprovals` olarak iletiyor. Bu satır
      // olmadan alt koşum bir insan kapısında sonsuza dek askıda kalırdı: soru sorulur, cevap
      // ebeveyne verilir, çocuğa hiç ulaşmaz.
      //
      // `gnlApprovals` ARTIK EBEVEYNİN TÜM HARİTASI DEĞİL: durable-tool onu bu çağrının kayıtlı
      // sentinel'indeki çocuk soru kimlikleriyle sınırlıyor (bkz. nestedApprovalsFor). Sebep
      // ölçülebilir bir çakışma: ardışık id üreten sağlayıcılarda ('call_0', 'call_1'…) iki koşumun
      // id uzayı aynıdır, ve ebeveynin KENDİ bir çağrısına verilmiş "evet" çocuğun bambaşka bir
      // insan-kapılı çağrısını sessizce açabiliyordu. `config.approvals` — host'un bu alt ajan için
      // AÇIKÇA yapılandırdığı onaylar — sınırlamanın dışında; oradaki niyet zaten çocuğa aittir.
      const inheritedApprovals = { ...(config.approvals ?? {}), ...(options?.gnlApprovals ?? {}) };
      // Scope the sub-agent's run to its PARENT — see nestedAgentRunId for why, and for why this
      // must stay derivable from (parentRunId, toolCallId) alone. network.ts has always keyed on
      // the parent (`net:${runId}:${i}`); this is the same shape.
      const parentRunId = config.parentRunId ?? options?.parentRunId;
      const nestedRunId = nestedAgentRunId(parentRunId, options?.toolCallId);
      const model = typeof config.model === 'function' ? await config.model(nestedRunId) : config.model;
      // The parent runId is injected into the tool's execute options by durable-tool.ts. If the
      // parent is tainted, carry that taint into the nested run before it runs any side-effect tool.
      await inheritParentTaint(config.journal, parentRunId, nestedRunId);
      const res = await runDurable({
        runId: nestedRunId,
        journal: config.journal,
        model,
        tools: config.tools,
        system: config.system,
        guard: config.guard,
        prompt: task,
        stopWhen: stepCountIs(config.maxSteps ?? 8),
        limits: config.limits,
        approvals: inheritedApprovals,
        // Aynı devir, agent-as-tool yolunda. (Yukarıdaki kardeşiyle tek fark nestedRunId'nin nereden
        // geldiği; kimlik açısından ikisi de aynı isteğin bir kare derinidir.)
        ...(config.resourceId ? { resourceId: config.resourceId } : {}),
        ...(config.threadId ? { threadId: config.threadId } : {}),
        ...(config.actor ? { actor: config.actor } : {}),
        ...(config.channel ? { channel: config.channel } : {}),
        ...(config.toolPolicy ? { toolPolicy: config.toolPolicy } : {}),
      } as any);
      // ÇOCUĞUN SORUSU EBEVEYNE ÇIKAR.
      //
      // Alt koşum bir insan kapısına çarptığında (confirm/guard/duplicate/semantic/taint) askıya
      // giriyor — ama ebeveyn bunu görmüyordu: `interrupts` sıradan bir araç çıktısı olarak dönüyor,
      // `hasSuspend` ise yalnız `__gnl_suspend` arıyor. Sonuç ölçüldü: ebeveyn `completed`,
      // `interrupts: []`, çocuk ise `suspended`. Yani insan kapısı çalıştı ve İNSANA ULAŞMADI —
      // "son söz insanda" vaadinin sessizce boşa çıktığı hâl.
      //
      // Sentinel ebeveynin KENDİ toolCallId'siyle üretiliyor (askı mekanizması onunla anahtarlanır),
      // ama soruyu doğuran ÇOCUK çağrıları `nested` alanında duruyor: cevap veren kişi neyi
      // onayladığını görebilmeli, ve onay o çağrı kimlikleriyle geri gelecek (tek harita, ayrı
      // eşleme yok — bkz. gnlApprovals).
      if (res.interrupts?.length) {
        const first = res.interrupts[0]!;
        return {
          text: res.text,
          interrupts: res.interrupts,
          __gnl_suspend: {
            toolCallId: options?.toolCallId,
            toolName: 'agent',
            args: { task },
            kind: 'nested',
            reason:
              `A delegated sub-agent stopped for a human: ${first.reason ?? 'approval required'} ` +
              `(nested run '${nestedRunId}', ${res.interrupts.length} pending). Answer with the nested toolCallId(s).`,
            // Çocuğun interrupt'ları TAM hâliyle saklanıyor (`args`/`semPair` dahil): run.ts bu
            // listeden yüzeye çıkan soruyu kuruyor, ve insan neyi onayladığını görebilmeli —
            // kırpılmış bir kayıt "bir alt ajan durdu" bildirimine geri döner. Aynı liste askı
            // kolunun tek karar kaynağı (bkz. durable-tool `nestedAnswered`) ve ebeveynin onay
            // haritasından çocuğa NEYİN inebileceğini de bu liste sınırlıyor.
            nested: { runId: nestedRunId, interrupts: res.interrupts.map((i) => ({ toolCallId: i.toolCallId, toolName: i.toolName, args: i.args, reason: i.reason, ...(i.semPair ? { semPair: i.semPair } : {}) })) },
          },
        } as any;
      }
      return { text: res.text, interrupts: res.interrupts };
    },
    // `idempotent` KALDIRILDI değil, KOŞULLU: alt koşum kendi journal'ından replay ettiği için
    // tekrar çağrı yan etki üretmiyor — bu doğru. Ama askı hâlinde ebeveynin kaydı 'suspended'
    // olur ve onay geldiğinde durable-tool'un askı kolu yeniden çalıştırır; idempotent bayrağı o
    // kolu engellemiyor (o, çökme-penceresi kapısı için).
  }), { idempotent: true });
}
