// Stdio MCP server (TC-MCP-01): newline-delimited JSON-RPC over stdin/stdout,
// proxying discovery to a registry's REST API. This is the install path for
// editor MCP hosts (Cursor, VS Code, Claude Desktop): one command, no HTTP setup.
import readline from 'node:readline';
import { readFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { extractFeatures, MCP_TOOLS, MCP_INSTRUCTIONS, summarizeNode, trustedView, trustedJurisdictionsFrom, inTrustedPool } from '@opennodes/core';

export { summarizeNode };

const { version: VERSION } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** What a local model could use here: 75% of RAM, leaving the rest to the system (a GPU's VRAM may be less). */
export const machineMemoryGb = () => Math.max(1, Math.floor((totalmem() / 1e9) * 0.75));

/**
 * sensitive: every request carries personal data (ONP_SENSITIVE=1): search and recommend use the
 * trusted pool only. trustedJurisdictions narrows it to this user's trusted operators (default:
 * ONP_TRUSTED_JURISDICTIONS, else EU,CA); the registry's own trusted view applies as well.
 */
export function createStdioMcp({ registry, input = process.stdin, output = process.stdout, sensitive = false, trustedJurisdictions = trustedJurisdictionsFrom() }) {
  const base = registry.replace(/\/$/, '');
  const view = trustedView(trustedJurisdictions);

  async function runTool(name, args = {}) {
    switch (name) {
      case 'recommend': {
        // This server runs on the user's machine: it can tell how much memory a local model could use.
        const assumed = args.policy?.local_memory_gb == null;
        if (assumed) args = { ...args, policy: { ...args.policy, local_memory_gb: machineMemoryGb() } };
        // Personal data (this server's setting, or the agent marked the task): the trusted pool, narrowed
        // to this user's trusted jurisdictions unless the agent asked for a narrower one.
        const marked = sensitive || args.policy?.sensitive === true;
        const policy = marked ? { ...args.policy, sensitive: true, jurisdiction: args.policy?.jurisdiction ?? view.jurisdictions } : (args.policy ?? {});
        // Privacy by construction: extract features here, send only those.
        const features = extractFeatures(String(args.task ?? ''), { est_output_tokens: args.est_output_tokens ?? null });
        const res = await fetch(`${base}/v0/recommend`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ features, policy }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.detail ?? `status ${res.status}`);
        // A registry that does not know `sensitive` ignores it and answers from both pools: refuse that answer.
        if (marked && !body.trusted_view) throw new Error(`the task is sensitive, but ${base} does not apply a trusted view (registry 0.1.52 or later): no recommendation returned`);
        if (assumed) body.local_memory = { gb: args.policy.local_memory_gb, basis: "75% of this machine's RAM; pass policy.local_memory_gb to override (a GPU's VRAM may be smaller)" };
        return body;
      }
      case 'search_offerings': {
        const marked = sensitive || args.trust === 'trusted';
        const query = marked ? { ...args, trust: 'trusted', jurisdiction: args.jurisdiction ?? view.jurisdictions } : args;
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) qs.set(k, String(v));
        const res = await fetch(`${base}/v0/offerings?${qs}`);
        if (!res.ok) throw new Error(`registry search failed: ${res.status}`);
        const body = await res.json();
        if (!marked) return body;
        // Checked here too, under this user's trusted view: an older registry ignores `trust`.
        const kept = (body.offerings ?? []).filter((o) => inTrustedPool(o, view));
        const removed = (body.offerings ?? []).length - kept.length;
        return { ...body, offerings: kept, sensitive: { trusted_view: view, ...(removed ? { removed_by_client: removed } : {}) } };
      }
      case 'find_locations': {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== null) qs.set(k, String(v));
        const res = await fetch(`${base}/v0/locations?${qs}`);
        if (!res.ok) throw new Error(`registry locations failed: ${res.status}`);
        return res.json();
      }
      case 'find_residency': {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== null) qs.set(k, String(v));
        const res = await fetch(`${base}/v0/residency?${qs}`);
        if (!res.ok) throw new Error(`registry residency failed: ${res.status}`);
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
          instructions: MCP_INSTRUCTIONS,
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: MCP_TOOLS });
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
