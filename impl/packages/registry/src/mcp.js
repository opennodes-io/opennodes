// DS-MCP-01: the registry as an MCP server (streamable HTTP, stateless).
// Minimal JSON-RPC handler covering initialize / tools/list / tools/call so any
// MCP host gets ONP discovery (search_offerings, get_offering, estimate) for free.
import { readJson, sendJson, problem, estimateBounds, round6 } from '@opennodes/core';
import { searchOfferings, collectOfferings } from './search.js';

const PROTOCOL_VERSION = '2025-06-18';

const TOOLS = [
  {
    name: 'search_offerings',
    description: 'Search AI inference offerings in the OpenNodes registry. Filters: modality (text|image|audio|video|embedding|multimodal|agent), family, min_context, supports (comma list: tool_calls,json_mode,vision,streaming), max_input_price (USD per MTok), scheme (free|prepaid|x402), tier (community|verified|attested), lang ("en:strong"), q (free text), sort (rank|price). Returns offerings with pricing, trust tier, and rank explanation.',
    inputSchema: {
      type: 'object',
      properties: {
        modality: { type: 'string' }, family: { type: 'string' },
        min_context: { type: 'number' }, supports: { type: 'string' },
        max_input_price: { type: 'number' }, scheme: { type: 'string' },
        tier: { type: 'string' }, lang: { type: 'string' },
        q: { type: 'string' }, sort: { type: 'string' }, limit: { type: 'number' },
      },
    },
  },
  {
    name: 'get_offering',
    description: 'Get full detail for one offering by node_id and offering_id, including endpoints, pricing, serving capabilities, and observed probe results.',
    inputSchema: {
      type: 'object',
      required: ['node_id', 'offering_id'],
      properties: { node_id: { type: 'string' }, offering_id: { type: 'string' } },
    },
  },
  {
    name: 'estimate',
    description: 'Estimate cost bounds for a planned invocation chain BEFORE spending money. Each step names a concrete offering ("node_id/offering_id") or a select query (same filters as search_offerings), plus est_input_tokens and est_output_tokens. Returns per-step cost, pinned card_revision (making the estimate enforceable at invocation), and totals.',
    inputSchema: {
      type: 'object',
      required: ['steps'],
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              offering: { type: 'string' },
              select: { type: 'object' },
              est_input_tokens: { type: 'number' },
              est_output_tokens: { type: 'number' },
            },
          },
        },
      },
    },
  },
];

async function runTool(store, name, args = {}) {
  switch (name) {
    case 'search_offerings': {
      const query = new URLSearchParams();
      for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== null) query.set(k, String(v));
      return { offerings: await searchOfferings(store, query) };
    }
    case 'get_offering': {
      const found = (await collectOfferings(store)).find(
        (o) => o.node_id === args.node_id && o.offering_id === args.offering_id);
      if (!found) throw new Error(`unknown offering: ${args.node_id}/${args.offering_id}`);
      return found;
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
        serverInfo: { name: 'opennodes-registry', version: '0.1.0' },
        instructions: 'OpenNodes registry: search AI inference offerings, inspect them, and pre-price invocation chains. Typical flow: search_offerings -> estimate -> invoke via the offering endpoints (invocation itself is not exposed here).',
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
