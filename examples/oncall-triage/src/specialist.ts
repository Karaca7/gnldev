// The database specialist — a SECOND agent, in its own process boundary, reached over the network.
//
// rb-escalation says: "If a second opinion is needed, ask the database specialist rather than paging
// again." That sentence is the reason this file exists. The alternative — giving the triage agent
// every database tool and a longer system prompt — fails for a reason that has nothing to do with
// model quality: the specialist's tools reach a production database, and the triage agent runs on
// whatever pages it. Two agents means two blast radii.
//
// TWO PACKAGES MEET HERE
//
//   @gnldev/mcp   the specialist's tools come from an MCP server — the org's database-inspection
//                 server, not code in this repo. Tool calls made through it are JOURNALED, so a
//                 resumed run does not re-query.
//   @gnldev/a2a   the triage agent calls the specialist as if it were a local tool. The call is a
//                 POST to the specialist's REST API, wrapped so a timeout or a 500 becomes a normal
//                 failed tool result the triage model can read and react to.
import { createA2ATool } from '@gnldev/a2a';
import { createMcpTools, type McpClientLike } from '@gnldev/mcp';
import { createRestApi } from '@gnldev/server';

/**
 * Stands in for the org's database-inspection MCP server.
 *
 * A real deployment passes `await connectMcp({ type: 'stdio', command: 'db-mcp' })` (or an http
 * transport) here instead. This is the same `McpClientLike` surface the SDK client satisfies, so
 * nothing downstream changes — which is the point of the example running with no setup at all.
 */
export function fakeDbMcpClient(): McpClientLike {
  return {
    async listTools() {
      return {
        tools: [
          {
            name: 'slowQueries',
            description: 'Lists the slowest queries for a service in the last 15 minutes.',
            inputSchema: {
              type: 'object',
              properties: { service: { type: 'string' } },
              required: ['service'],
            },
          },
          {
            name: 'connectionPool',
            description: 'Reports connection pool usage for a service.',
            inputSchema: {
              type: 'object',
              properties: { service: { type: 'string' } },
              required: ['service'],
            },
          },
        ],
      };
    },
    async callTool({ name, arguments: args }) {
      const service = String((args as any)?.service ?? 'unknown');
      if (name === 'slowQueries') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              service,
              slowest: [
                { sql: 'SELECT * FROM orders WHERE customer_id = $1', meanMs: 1840, calls: 12400 },
                { sql: 'SELECT count(*) FROM order_items', meanMs: 610, calls: 300 },
              ],
            }),
          }],
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ service, inUse: 48, size: 50, waiting: 6 }) }],
      };
    },
  };
}

/**
 * Builds the specialist as a standalone REST API.
 *
 * `allowOpenAccess` is set because this app is never bound to a socket in the demo — the triage agent
 * reaches it through `app.request` in-process (see below). A specialist that IS deployed gets an
 * `auth` provider instead, and `createRestApi` refuses to start without one under NODE_ENV=production
 * precisely so that decision cannot be forgotten.
 */
export async function buildSpecialist(storage: any, model: any) {
  const dbTools = await createMcpTools(fakeDbMcpClient(), { prefix: 'db_' });

  const app = createRestApi(
    {
      storage,
      agents: {
        dbSpecialist: {
          model,
          tools: dbTools,
          system:
            'You are a database specialist. Answer with the specific query or pool number that ' +
            'explains the symptom. Do not recommend restarts.',
          maxSteps: 4,
        },
      },
    },
    { title: 'DB Specialist', allowOpenAccess: true },
  );

  /**
   * The tool the triage agent sees. `fetchImpl` routes the call through the in-process app rather than
   * a socket — the same code path a real deployment takes, minus the port.
   */
  const askSpecialist = createA2ATool({
    endpoint: 'http://specialist.internal',
    agentName: 'dbSpecialist',
    description:
      'Asks the database specialist for a second opinion. Use this instead of paging a second time.',
    fetchImpl: ((input: any, init?: any) => (app as any)(new Request(input, init))) as typeof fetch,
    timeoutMs: 10_000,
  });

  return { app, askSpecialist, dbTools };
}
