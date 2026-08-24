#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { stepCountIs } from 'ai';
import { runDurable } from '../run.js';
import { InMemoryJournal } from '../journal.js';
import type { Journal } from '../journal.js';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a?.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = 'true';
    else out[key] = argv[++i]!;
  }
  return out;
}

async function loadModel(provider: string, modelId: string): Promise<any> {
  const spec = provider === 'openai' ? '@ai-sdk/openai' : '@ai-sdk/anthropic';
  const mod: any = await import(spec).catch(() => null);
  if (!mod) throw new Error(`\`${spec}\` is not installed. Run: npm i ${spec}`);
  return provider === 'openai' ? mod.openai(modelId) : mod.anthropic(modelId);
}

async function loadJournal(dbPath?: string): Promise<Journal> {
  if (!dbPath) return new InMemoryJournal();
  const { SqliteStorage } = await import('../sqlite-storage.js');
  return new SqliteStorage(dbPath).runs; // RunJournal = journal (new indexed schema)
}

function printHelp(): void {
  console.log(`gnl chat — durable agent terminal REPL

Usage: gnl chat [--provider anthropic|openai] [--model <id>] [--db <path>] [--session <id>]

  --provider   LLM provider (default: anthropic)
  --model      model id (default: claude-opus-4-8 / gpt-4o-mini)
  --db         SQLite database file path (in-memory if not given)
  --session    session prefix (for resume; defaults to chat-<time>)

API key: ANTHROPIC_API_KEY / OPENAI_API_KEY environment variable.`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();

  const provider = args.provider ?? 'anthropic';
  const modelId = args.model ?? (provider === 'openai' ? 'gpt-4o-mini' : 'claude-opus-4-8');
  const session = args.session ?? `chat-${Date.now()}`;
  const journal = await loadJournal(args.db);

  let model: any;
  try {
    model = await loadModel(provider, modelId);
  } catch (e) {
    console.error('✖', (e as Error).message);
    process.exit(1);
  }

  console.log(
    `gnl chat · ${provider}/${modelId} · session=${session}` + (args.db ? ` · db=${args.db}` : ' · (in-memory)'),
  );
  console.log('Exit: Ctrl+C\n');

  const messages: any[] = [];
  const rl = createInterface({ input: stdin, output: stdout });
  let turn = 0;

  for (;;) {
    const input = (await rl.question('› ')).trim();
    if (!input) continue;
    messages.push({ role: 'user', content: input });
    const turnRunId = `${session}:t${turn++}`;

    try {
      let res: any = await runDurable({ runId: turnRunId, journal, model, messages, stopWhen: stepCountIs(12) });

      // If suspended via require-approval, ask for approval, then resume.
      while (res.interrupts?.length) {
        const approvals: Record<string, boolean> = {};
        for (const it of res.interrupts) {
          const ans = await rl.question(`  ⏸ approval needed: ${it.toolName}(${JSON.stringify(it.args)}) [y/n] `);
          approvals[it.toolCallId] = ans.trim().toLowerCase().startsWith('y');
        }
        res = await runDurable({ runId: turnRunId, journal, model, messages, approvals, stopWhen: stepCountIs(12) });
      }

      for (const step of res.steps ?? []) {
        for (const part of step.content ?? []) {
          if (part.type === 'tool-call') {
            console.log(`  \x1b[2m· ${part.toolName}(${JSON.stringify(part.input)})\x1b[0m`);
          }
        }
      }
      console.log(res.text);
      const total = res.usage?.totalTokens;
      if (total != null) console.log(`  \x1b[2m(${total} tokens)\x1b[0m`);
      messages.push({ role: 'assistant', content: res.text });
    } catch (e) {
      console.error('  ✖', (e as Error).message);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
