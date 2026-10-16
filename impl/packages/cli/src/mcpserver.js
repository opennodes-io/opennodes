// Stdio MCP server (TC-MCP-01): newline-delimited JSON-RPC over stdin/stdout,
// proxying discovery to a registry's REST API. This is the install path for
// editor MCP hosts (Cursor, VS Code, Claude Desktop): one command, no HTTP setup.
import readline from 'node:readline';
import { readFileSync } from 'node:fs';
import { extractFeatures } from '@opennodes/core';

const { version: VERSION } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const TIER = { type: 'string', enum: ['unverified', 'community', 'verified', 'attested'] };

// Filters shared by search_offerings and an estimate step's `select`.
const FILTERS = {
  modality: { type: 'string', enum: ['text', 'image', 'audio', 'video', 'embedding', 'multimodal', 'agent'], description: 'What the model consumes/produces. Use "text" for chat and completion models.' },
  family: { type: 'string', description: 'Model family or exact artifact, e.g. "llama-3.3" or "qwen3". Matches model.family or model.artifact exactly.' },
  min_context: { type: 'integer', minimum: 1, description: 'Minimum context window in tokens, e.g. 32768.' },
  supports: { type: 'string', description: 'Comma-separated features the offering must all support: tool_calls, json_mode, vision, streaming. Example: "tool_calls,json_mode".' },
  max_input_price: { type: 'number', minimum: 0, description: 'Maximum input price in USD per million tokens.' },
  scheme: { type: 'string', enum: ['free', 'prepaid', 'x402'], description: 'Payment scheme the offering must accept. "free" finds no-cost offerings.' },
  tier: { ...TIER, description: 'Minimum trust tier. unverified < community (passed automated checks) < verified (identity and context verified) < attested.' },
  lang: { type: 'string', description: 'Language with minimum grade, "<iso-code>[:basic|strong|native]", e.g. "pl:strong" or "de".' },
  q: { type: 'string', description: 'Free-text match against the model metadata, offering id, and node id, e.g. "bielik" or "coder".' },
};

const TOOLS = [
  {
    name: 'recommend',
    title: 'Recommend a node and model',
    description: "Recommend the best AI node + model for a task, with an enforceable cost estimate and human-readable reasons. Use this first when you know the task but not the model. Features (task class, size, language, needs) are extracted LOCALLY from `task` and only those features are sent to the registry — the prompt never leaves this machine. Returns ranked candidates with score components, a cost estimate pinned to the node's card revision, an optional cheaper two-step scenario, and MCP tool categories the task likely needs. To browse instead, use search_offerings; to price a specific chain, use estimate.",
    inputSchema: {
      type: 'object', required: ['task'], additionalProperties: false,
      properties: {
        task: { type: 'string', minLength: 1, description: 'The task description or the prompt itself, e.g. "Translate this Polish contract to English and list the risks". Analysed locally; not sent.' },
        est_output_tokens: { type: 'integer', minimum: 1, description: 'Expected answer length in tokens, if known. Improves the cost estimate; otherwise inferred from the task.' },
        policy: {
          type: 'object', additionalProperties: false,
          description: 'Optional constraints and preferences for the recommendation.',
          properties: {
            preset: { type: 'string', enum: ['cheap', 'fast', 'quality', 'private'], description: 'Weighting preset: cheap favours price, fast favours latency/throughput, quality favours model strength, private favours trust tier.' },
            min_tier: { ...TIER, description: 'Exclude offerings below this trust tier.' },
            max_input_per_mtok: { type: 'number', minimum: 0, description: 'Maximum input price in USD per million tokens.' },
            max_total_usd: { type: 'number', minimum: 0, description: 'Maximum estimated total cost of the call in USD.' },
            region: { type: 'string', description: 'Required data region, e.g. "eu". Offerings pinned to other regions are excluded.' },
            prefer_local: { type: 'boolean', description: 'Give a bonus to nodes on this machine or LAN.' },
            limit: { type: 'integer', minimum: 1, maximum: 20, default: 3, description: 'Number of candidates to return.' },
          },
        },
      },
    },
    annotations: { title: 'Recommend a node and model', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'search_offerings',
    title: 'Search inference offerings',
    description: "Search AI inference offerings in the OpenNodes registry — registered nodes AND imported catalogs (OpenRouter, Hugging Face Inference Providers, models.dev, local nodes). All filters are optional and combine with AND. Returns { offerings, total }: each offering has node_id, offering_id, model, pricing (USD per MTok), trust tier, serving capabilities, measured probe results, and a rank explanation. Use get_offering for one offering's full card, recommend to let the advisor choose.",
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        ...FILTERS,
        sort: { type: 'string', enum: ['rank', 'price', 'ttft', 'tps'], default: 'rank', description: 'rank = registry ranking (price, trust, reliability); price = cheapest input first; ttft = fastest first token; tps = highest throughput.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50, description: 'Maximum offerings to return; `total` still counts every match.' },
      },
    },
    annotations: { title: 'Search inference offerings', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'get_offering',
    title: 'Get one offering',
    description: "Full detail for one offering: endpoints, pricing, serving capabilities (context window, supported features, languages, hardware), data policy, trust tier, and the registry's observed probe results. Take node_id and offering_id from search_offerings or recommend results.",
    inputSchema: {
      type: 'object', required: ['node_id', 'offering_id'], additionalProperties: false,
      properties: {
        node_id: { type: 'string', minLength: 1, description: 'Reverse-DNS node id, e.g. "io.opennodes.demo-node".' },
        offering_id: { type: 'string', minLength: 1, description: 'Offering id within that node, as returned by search_offerings.' },
      },
    },
    annotations: { title: 'Get one offering', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'get_node',
    title: 'Get one node',
    description: "Who runs a node and how it has behaved: operator, country and regions, endpoints, declared hardware, trust tier and its history (verifications, suspensions, reinstatements, with reasons), recent registry probe results with an availability summary, and its offerings with context window and price. Use it to vet a provider before relying on it; take node_id from search_offerings, recommend or get_offering results. For one offering's full card, use get_offering.",
    inputSchema: {
      type: 'object', required: ['node_id'], additionalProperties: false,
      properties: {
        node_id: { type: 'string', minLength: 1, description: 'Reverse-DNS node id, e.g. "io.opennodes.demo-node" or "import.openrouter.ai".' },
        offering_limit: { type: 'integer', minimum: 0, maximum: 200, default: 25, description: 'Maximum offerings to list; imported catalogs can hold hundreds. `offerings_total` always gives the full count.' },
      },
    },
    annotations: { title: 'Get one node', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'estimate',
    title: 'Estimate the cost of a chain',
    description: 'Pre-price an invocation chain BEFORE spending money. Each step is either a concrete offering ("node_id/offering_id") or a `select` query that picks the best match, plus expected input and output tokens. Returns per-step cost bounds in USD, the pinned card_revision that makes each estimate enforceable at invocation, and chain totals. Use it to compare routes or budget a multi-model pipeline; nothing is invoked or charged.',
    inputSchema: {
      type: 'object', required: ['steps'], additionalProperties: false,
      properties: {
        steps: {
          type: 'array', minItems: 1, maxItems: 20,
          description: 'Steps in execution order.',
          items: {
            type: 'object', required: ['est_input_tokens', 'est_output_tokens'], additionalProperties: false,
            properties: {
              offering: { type: 'string', description: 'Concrete offering as "node_id/offering_id". Give this or `select`.' },
              select: { type: 'object', additionalProperties: false, properties: FILTERS, description: 'Pick the best-ranked offering matching these filters (same as search_offerings). Give this or `offering`.' },
              est_input_tokens: { type: 'integer', minimum: 0, description: 'Expected prompt tokens for this step.' },
              est_output_tokens: { type: 'integer', minimum: 0, description: 'Expected completion tokens for this step.' },
            },
          },
        },
      },
    },
    annotations: { title: 'Estimate the cost of a chain', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
];

// Registry node detail → what an agent needs to vet a provider. Drops signatures and
// raw cards (imported catalogs carry hundreds of offerings).
export function summarizeNode(node, offeringLimit = 25) {
  const card = node.card ?? {};
  const offerings = card.offerings ?? [];
  const liveness = (node.probes ?? []).filter((p) => p.kind === 'liveness');
  return {
    id: node.id,
    name: card.node?.name ?? node.id,
    description: card.node?.description ?? null,
    operator: card.node?.operator?.name ?? null,
    country: card.node?.operator?.country ?? null,
    regions: card.node?.regions ?? [],
    tier: node.state === 'indexed' ? 'unverified' : node.state,
    source: node.source ?? 'registration',
    institutional: Boolean(node.institutional),
    origin: node.origin ?? null,
    card_url: node.card_url ?? null,
    card_revision: card.revision ?? null,
    endpoints: card.endpoints ?? {},
    hardware: card.hardware ?? null,
    payment_schemes: (card.payment?.schemes ?? []).map((s) => s.scheme),
    listed_at: node.created_at ?? null,
    updated_at: node.updated_at ?? null,
    availability: liveness.length ? {
      checks: liveness.length,
      ok: liveness.filter((p) => p.ok).length,
      last_check_at: liveness[0].at,
      last_ok_at: liveness.find((p) => p.ok)?.at ?? null,
    } : null,
    recent_probes: (node.probes ?? []).slice(0, 10).map((p) => ({
      at: p.at, stage: p.stage, kind: p.kind, offering_id: p.offering_id ?? null, ok: Boolean(p.ok), detail: p.detail ?? null,
    })),
    history: (node.history ?? []).slice(-10).reverse().map((h) => ({ at: h.at, from: h.from_state, to: h.to_state, reason: h.reason })),
    offerings_total: offerings.length,
    offerings: offerings.slice(0, offeringLimit).map((o) => ({
      offering_id: o.offering_id,
      model: o.model?.name ?? null,
      modality: o.modality,
      context_window: o.serving?.context_window ?? null,
      supports: o.serving?.supports ?? [],
      pricing: o.pricing ? { currency: o.pricing.currency, input_per_mtok: o.pricing.input_per_mtok, output_per_mtok: o.pricing.output_per_mtok, schemes: o.pricing.schemes } : null,
      retention: o.data_policy?.retention ?? null,
    })),
  };
}

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
      case 'get_node': {
        const res = await fetch(`${base}/v0/nodes/${encodeURIComponent(args.node_id)}`);
        const body = await res.json();
        if (res.status === 404) throw new Error(`unknown node: ${args.node_id} (node ids come from search_offerings or recommend results)`);
        if (!res.ok) throw new Error(body.detail ?? `status ${res.status}`);
        return summarizeNode(body, args.offering_limit ?? 25);
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
          serverInfo: { name: 'opennodes', title: 'OpenNodes', version: VERSION },
          instructions: "OpenNodes finds and prices AI inference endpoints across registered nodes and imported catalogs (OpenRouter, Hugging Face, models.dev, local). Start with recommend when you know the task; use search_offerings to browse with filters, get_offering for one offering's full detail, get_node to vet who runs a node and how it has behaved, and estimate to price a multi-step chain before running it. All tools are read-only: nothing is invoked or charged.",
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
