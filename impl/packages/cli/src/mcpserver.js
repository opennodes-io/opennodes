// Stdio MCP server (TC-MCP-01): newline-delimited JSON-RPC over stdin/stdout,
// proxying discovery to a registry's REST API. This is the install path for
// editor MCP hosts (Cursor, VS Code, Claude Desktop): one command, no HTTP setup.
import readline from 'node:readline';
import { extractFeatures } from '@opennodes/core';

const TOOLS = [
  {
    name: 'recommend',
    description: 'Recommend the best AI node + model for a task, with an enforceable cost estimate and reasons. Pass the task or prompt; features are extracted LOCALLY and only the features (task class, size, language, needs) are sent to the registry — the prompt never leaves this machine. Optional policy: min_tier, max_input_per_mtok, max_total_usd, region, prefer_local, preset (cheap|fast|quality|private), limit. Also returns an optional two-step scenario and MCP tool categories the task likely needs.',
    inputSchema: {
      type: 'object', required: ['task'],
      properties: {
        task: { type: 'string' }, est_output_tokens: { type: 'number' },
        policy: { type: 'object' },
      },
    },
  },
  {
    name: 'search_offerings',
    description: 'Search AI inference offerings across the OpenNodes registry — spans registered nodes AND imported catalogs (OpenRouter, Hugging Face Inference Providers, models.dev, local nodes). Filters: modality (text|image|audio|video|embedding|multimodal), family, min_context, supports (comma list: tool_calls,json_mode,vision,streaming), max_input_price (USD per MTok), scheme (free|prepaid), tier (unverified|community|verified), lang ("en:strong"), q (free text), sort (rank|price), limit.',
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
    description: 'Full detail for one offering (endpoints, pricing, serving capabilities, observed probe results) by node_id and offering_id.',
    inputSchema: {
      type: 'object', required: ['node_id', 'offering_id'],
      properties: { node_id: { type: 'string' }, offering_id: { type: 'string' } },
    },
  },
  {
    name: 'estimate',
    description: 'Pre-price an invocation chain BEFORE spending money. Steps name a concrete offering ("node_id/offering_id") or a select query (same filters as search_offerings) plus est_input_tokens / est_output_tokens. Returns per-step cost bounds and pinned card_revision (enforceable at invocation), plus totals. Use this to compare routes or budget a multi-model computation.',
    inputSchema: {
      type: 'object', required: ['steps'],
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              offering: { type: 'string' }, select: { type: 'object' },
              est_input_tokens: { type: 'number' }, est_output_tokens: { type: 'number' },
            },
          },
        },
      },
    },
  },
];

export function createStdioMcp({ registry, input = process.stdin, output = process.stdout }) {
  const base = registry.replace(/\/$/, '');

  async function runTool(name, args = {}) {
    switch (name) {
      case 'recommend': {
        // Privacy by construction: extract features here, send only those.
        const features = extractFeatures(String(args.task ?? ''), { est_output_tokens: args.est_output_tokens ?? null });
        const res = await fetch(`${base}/v0/recommend`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ features, policy: args.policy ?? {} }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.detail ?? `status ${res.status}`);
        return body;
      }
      case 'search_offerings': {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== null) qs.set(k, String(v));
        const res = await fetch(`${base}/v0/offerings?${qs}`);
        if (!res.ok) throw new Error(`registry search failed: ${res.status}`);
        return res.json();
      }
      case 'get_offering': {
        const res = await fetch(`${base}/v0/offerings/${encodeURIComponent(args.node_id)}/${encodeURIComponent(args.offering_id)}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body.detail ?? `status ${res.status}`);
        return body;
      }
      case 'estimate': {
        const res = await fetch(`${base}/v0/estimate`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ steps: args.steps }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.detail ?? `status ${res.status}`);
        return body;
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }

  async function handle(msg) {
    const { id, method, params } = msg;
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'opennodes', version: '0.1.0' },
          instructions: 'OpenNodes discovery: search inference offerings across registered nodes and imported catalogs (OpenRouter, Hugging Face, local), inspect them, and pre-price multi-step chains with enforceable estimates.',
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call':
        try {
          const result = await runTool(params?.name, params?.arguments);
          return reply({
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
            isError: false,
          });
        } catch (err) {
          return reply({ content: [{ type: 'text', text: String(err.message) }], isError: true });
        }
      case 'resources/list': return reply({ resources: [] });
      case 'prompts/list': return reply({ prompts: [] });
      default:
        if (method?.startsWith('notifications/')) return null;
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
    }
  }

  const rl = readline.createInterface({ input });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const response = await handle(msg);
    if (response) output.write(JSON.stringify(response) + '\n');
  });
  return { close: () => rl.close() };
}
