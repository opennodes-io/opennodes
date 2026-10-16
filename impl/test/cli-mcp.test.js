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
  assert.deepEqual(tools.map((tl) => tl.name).sort(), ['estimate', 'get_offering', 'recommend', 'search_offerings']);
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
