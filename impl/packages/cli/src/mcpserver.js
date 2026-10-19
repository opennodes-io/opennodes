// Stdio MCP server (TC-MCP-01): newline-delimited JSON-RPC over stdin/stdout,
// proxying discovery to a registry's REST API. This is the install path for
// editor MCP hosts (Cursor, VS Code, Claude Desktop): one command, no HTTP setup.
import readline from 'node:readline';
import { readFileSync } from 'node:fs';
import { extractFeatures, MCP_TOOLS, MCP_INSTRUCTIONS, summarizeNode } from '@opennodes/core';

export { summarizeNode };

const { version: VERSION } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

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
