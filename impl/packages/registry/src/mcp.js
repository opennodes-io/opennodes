// DS-MCP-01: the registry as an MCP server (streamable HTTP, stateless).
// Minimal JSON-RPC handler covering initialize / tools/list / tools/call so any
// MCP host gets ONP discovery (recommend, search_offerings, get_offering, get_node, estimate) for free.
import { readFileSync } from 'node:fs';
import { readJson, sendJson, problem, estimateBounds, round6, extractFeatures, recommend, MCP_TOOLS, MCP_INSTRUCTIONS, summarizeNode } from '@opennodes/core';
import { searchOfferingsPaged, searchOfferings, collectOfferings } from './search.js';

const PROTOCOL_VERSION = '2025-06-18';
const { version: VERSION } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// Same tools as the stdio server in @opennodes/cli (definitions live in core). Two differences
// on a remote endpoint: a `task` passed to recommend is sent here, so the schema says so and
// offers `features` (from a local extractFeatures) as the private alternative.
const TOOLS = MCP_TOOLS.map((tool) => {
  if (tool.name !== 'recommend') return tool;
  const { task, ...rest } = tool.inputSchema.properties;
  return {
    ...tool,
    description: "Recommend the best AI node + model for a task, with an enforceable cost estimate and human-readable reasons. Use this first when you know the task but not the model. Pass `task` (sent to this registry, which extracts features and discards the text) or `features` already extracted on your side with extractFeatures from @opennodes/core, which keeps the prompt private. Returns ranked candidates with score components, a cost estimate pinned to the node's card revision, an optional cheaper two-step scenario, and MCP tool categories the task likely needs. To browse instead, use search_offerings; to price a specific chain, use estimate.",
    inputSchema: {
      ...tool.inputSchema,
      required: [],
      properties: {
        task: { ...task, description: 'The task description or the prompt itself. Sent to the registry for feature extraction; use `features` to keep it private. Give this or `features`.' },
        features: { type: 'object', description: 'Features from extractFeatures(prompt) in @opennodes/core: task class, size, language and needs, no prompt text. Give this or `task`.' },
        ...rest,
      },
    },
  };
});

async function runTool(store, name, args = {}) {
  switch (name) {
    case 'recommend': {
      const features = args.features ?? (args.task != null
        ? extractFeatures(String(args.task), { est_output_tokens: args.est_output_tokens ?? null }) : null);
      if (!features) throw new Error('recommend needs "task" or "features"');
      return recommend((await collectOfferings(store)).filter((o) => o.invocable), features, args.policy ?? {});
    }
    case 'search_offerings': {
      const query = new URLSearchParams();
      for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== null) query.set(k, String(v));
      return searchOfferingsPaged(store, query);
    }
    case 'get_offering': {
      const found = (await collectOfferings(store)).find(
        (o) => o.node_id === args.node_id && o.offering_id === args.offering_id);
      if (!found) throw new Error(`unknown offering: ${args.node_id}/${args.offering_id}`);
      return found;
    }
    case 'get_node': {
      const node = await store.getNode(args.node_id);
      if (!node) throw new Error(`unknown node: ${args.node_id} (node ids come from search_offerings or recommend results)`);
      return summarizeNode({
        ...node,
        card: await store.latestCard(node.id),
        probes: (await store.probesFor(node.id)).slice(0, 20),
        history: await store.transitionsFor(node.id),
      }, args.offering_limit ?? 25);
    }
    case 'estimate': {
      const all = await collectOfferings(store);
      const steps = [];
      let min = 0, max = 0, currency = 'USD';
      for (const step of args.steps ?? []) {
        let offering;
        if (step.offering) {
          const [nodeId, offeringId] = step.offering.split('/');
          offering = all.find((o) => o.node_id === nodeId && o.offering_id === offeringId);
          if (!offering) throw new Error(`unknown offering: ${step.offering}`);
        } else if (step.select) {
          const query = new URLSearchParams();
          for (const [k, v] of Object.entries(step.select)) query.set(k, String(v));
          offering = (await searchOfferings(store, query))[0];
          if (!offering) throw new Error(`no offering matches select: ${JSON.stringify(step.select)}`);
        } else {
          throw new Error('each step needs "offering" or "select"');
        }
        const bounds = estimateBounds(offering.pricing, step.est_input_tokens ?? 0, step.est_output_tokens ?? 0);
        currency = offering.pricing.currency;
        min += bounds.min; max += bounds.max;
        steps.push({
          offering: `${offering.node_id}/${offering.offering_id}`,
          card_revision: offering.card_revision,
          cost: { currency, ...bounds },
        });
      }
      return { total: { currency, min: round6(min), max: round6(max) }, steps };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

async function handleRpc(store, msg) {
  const { id, method, params } = msg;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const rpcError = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'opennodes-registry', title: 'OpenNodes registry', version: VERSION },
        instructions: MCP_INSTRUCTIONS,
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call':
      try {
        const result = await runTool(store, params?.name, params?.arguments);
        return reply({
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: false,
        });
      } catch (err) {
        return reply({ content: [{ type: 'text', text: String(err.message) }], isError: true });
      }
    case 'resources/list':
      return reply({ resources: [] });
    case 'prompts/list':
      return reply({ prompts: [] });
    default:
      if (method?.startsWith('notifications/')) return null; // notifications get no response
      return rpcError(-32601, `method not found: ${method}`);
  }
}

/** Routes to mount into the registry app. */
export function mcpRoutes(store) {
  return [
    ['POST', '/mcp', async (req, res) => {
      const body = await readJson(req, 5_000_000);
      const messages = Array.isArray(body) ? body : [body];
      const replies = (await Promise.all(messages.map((m) => handleRpc(store, m)))).filter(Boolean);
      if (replies.length === 0) { res.writeHead(202); res.end(); return; }
      sendJson(res, 200, Array.isArray(body) ? replies : replies[0]);
    }],
    ['GET', '/mcp', (req, res) => {
      problem(res, 405, 'method-not-allowed', 'stateless MCP server: POST JSON-RPC messages to this endpoint');
    }],
  ];
}
