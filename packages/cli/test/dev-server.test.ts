// buildDevApp: REST (@gnl/server) + Studio Playground (@gnl/studio) in a single Hono app.
// buildDevApp takes the resolved runtime modules explicitly (see runtime.ts) — in production these
// come from loadDevRuntime(projectDir, config) (project-resolved); here, since the test IS the
// project (this is the monorepo), we statically import the same modules `gnl dev` would dynamically
// resolve — same instances, same behavior, no dynamic-import indirection needed for a unit test.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnl/durable';
import * as Durable from '@gnl/durable';
import * as Hono from 'hono';
import * as Server from '@gnl/server';
import * as Studio from '@gnl/studio';
import * as StudioAi from '@gnl/studio/ai';
import * as Auth from '@gnl/auth';
import { buildDevApp, type DevRuntimeModules } from '../src/dev-server.js';

const rt: DevRuntimeModules = { hono: Hono, durable: Durable, server: Server, studio: Studio, studioAi: StudioAi, auth: Auth };

function echoModel(): any {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'echo',
    supportedUrls: {},
    doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] }),
    doStream: async () => {
      throw new Error('no stream');
    },
  };
}

describe('buildDevApp', () => {
  it('REST /agents + Studio /studio/api/capabilities are served in a single app', async () => {
    const journal = new InMemoryJournal();
    const app = buildDevApp({ journal, agents: { assistant: { model: echoModel(), maxSteps: 4 } } }, rt);

    const agents = (await (await app.request('/agents')).json()) as any[];
    expect(agents[0].name).toBe('assistant');

    const caps = await (await app.request('/studio/api/capabilities')).json();
    expect(caps.playground).toBe(true);
    expect(caps.stream).toBe(true);

    const spec = await (await app.request('/openapi.json')).json();
    expect(spec.paths['/agents/assistant/stream']).toBeDefined();
  });

  it('studio:false → /studio is not mounted', async () => {
    const app = buildDevApp({ journal: new InMemoryJournal(), agents: {}, studio: false }, rt);
    expect((await app.request('/studio/api/capabilities')).status).toBe(404);
  });
});
