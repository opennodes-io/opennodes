// Stdio MCP server shipped in @opennodes/cli: what directories (Glama, MCP Registry) inspect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { createStdioMcp } from '@opennodes/cli/src/mcpserver.js';

function session() {
  const input = new PassThrough();
  const output = new PassThrough();
  const mcp = createStdioMcp({ registry: 'http://127.0.0.1:9', input, output });
  let buffer = '';
  const waiting = new Map();
  output.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      waiting.get(msg.id)?.(msg);
    }
  });
  let next = 1;
  const rpc = (method, params) => new Promise((resolve) => {
    const id = next++;
    waiting.set(id, resolve);
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { rpc, close: () => mcp.close() };
}

test('cli MCP server reports its package version and documents every tool parameter', async (t) => {
  const { rpc, close } = session();
  t.after(close);
  const pkg = JSON.parse(readFileSync(new URL('../packages/cli/package.json', import.meta.url), 'utf8'));

  const init = (await rpc('initialize', {})).result;
  assert.equal(init.serverInfo.version, pkg.version);
  assert.ok(init.instructions.length > 0);

  const tools = (await rpc('tools/list')).result.tools;
  assert.deepEqual(tools.map((tl) => tl.name).sort(), ['estimate', 'get_node', 'get_offering', 'recommend', 'search_offerings']);
  const undocumented = [];
  const walk = (schema, path) => {
    for (const [key, prop] of Object.entries(schema.properties ?? {})) {
      if (!prop.description) undocumented.push(path + key);
      if (prop.type === 'object') walk(prop, `${path}${key}.`);
      if (prop.items) walk(prop.items, `${path}${key}[].`);
    }
  };
  for (const tl of tools) {
    assert.ok(tl.title, `${tl.name} has a title`);
    assert.equal(tl.annotations?.readOnlyHint, true, `${tl.name} is marked read-only`);
    walk(tl.inputSchema, `${tl.name}:`);
  }
  assert.deepEqual(undocumented, []);
});

test('get_node summary keeps vetting facts and caps imported catalogs', async () => {
  const { summarizeNode } = await import('@opennodes/cli/src/mcpserver.js');
  const offering = (i) => ({ offering_id: `m${i}`, modality: 'text', model: { name: `model-${i}` }, serving: { context_window: 8192, supports: ['streaming'] }, pricing: { currency: 'USD', input_per_mtok: 0, output_per_mtok: 0, schemes: ['free'] }, data_policy: { retention: 'none' } });
  const node = {
    id: 'io.example.node', state: 'verified', source: 'registration', origin: 'https://node.example.io', created_at: '2026-10-01T00:00:00Z',
    card: { revision: 'r1', node: { name: 'Example', operator: { name: 'Example Ltd', country: 'PL' }, regions: ['eu'] }, offerings: [0, 1, 2].map(offering), signatures: [{ signature: 'x' }] },
    probes: [
      { at: '2026-10-16T10:10:00Z', stage: 'C', kind: 'liveness', ok: 0 },
      { at: '2026-10-16T10:05:00Z', stage: 'C', kind: 'liveness', ok: 1 },
      { at: '2026-10-16T10:00:00Z', stage: 'C', kind: 'blind', offering_id: 'm0', ok: 1 },
    ],
    history: [
      { at: '2026-10-01T00:00:00Z', from_state: 'indexed', to_state: 'community', reason: 'stage A passed' },
      { at: '2026-10-02T00:00:00Z', from_state: 'community', to_state: 'verified', reason: 'stage B passed' },
    ],
  };
  const s = summarizeNode(node, 2);
  assert.equal(s.tier, 'verified');
  assert.equal(s.operator, 'Example Ltd');
  assert.deepEqual(s.availability, { checks: 2, ok: 1, last_check_at: '2026-10-16T10:10:00Z', last_ok_at: '2026-10-16T10:05:00Z' });
  assert.equal(s.history[0].to, 'verified', 'history is newest first');
  assert.equal(s.offerings_total, 3);
  assert.deepEqual(s.offerings.map((o) => o.offering_id), ['m0', 'm1']);
  assert.equal(JSON.stringify(s).includes('signature'), false);
  assert.equal(summarizeNode({ ...node, state: 'indexed', probes: [] }).tier, 'unverified');
});
