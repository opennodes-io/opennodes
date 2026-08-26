// MCP surface e2e: a host-like client does the initialize handshake and calls the discovery tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureNode } from '@opennodes/fixture-node';
import { startRegistry } from '@opennodes/registry';

async function setupNetwork(t) {
  const node = await startFixtureNode();
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(async () => { await node.close(); await registry.close(); });
  const reg = await (await fetch(`${registry.origin}/v0/nodes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card_url: `${node.origin}/.well-known/open-node.json` }),
  })).json();
  node.setChallenge(reg.challenge.token);
  await fetch(`${registry.origin}${reg.challenge.verify}`, { method: 'POST' });
  return { node, registry };
}

const rpc = async (origin, method, params, id = 1) => {
  const res = await fetch(`${origin}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return { status: res.status, body: res.status === 202 ? null : await res.json() };
};

test('MCP handshake, tools/list, and discovery tool calls', async (t) => {
  const { registry } = await setupNetwork(t);

  // initialize
  const init = await rpc(registry.origin, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-host', version: '0.0.1' },
  });
  assert.equal(init.body.result.serverInfo.name, 'opennodes-registry');
  assert.ok(init.body.result.capabilities.tools);

  // notifications/initialized gets 202, no body
  const note = await fetch(`${registry.origin}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  assert.equal(note.status, 202);

  // tools/list exposes the three discovery tools
  const tools = (await rpc(registry.origin, 'tools/list')).body.result.tools.map((tl) => tl.name);
  assert.deepEqual(tools.sort(), ['estimate', 'get_offering', 'search_offerings']);

  // search_offerings
  const search = await rpc(registry.origin, 'tools/call', {
    name: 'search_offerings',
    arguments: { modality: 'text', lang: 'en:strong', sort: 'price' },
  });
  assert.equal(search.body.result.isError, false);
  const found = search.body.result.structuredContent.offerings;
  assert.equal(found.length, 1);
  assert.equal(found[0].node_id, 'org.opennodes.fixture');
  assert.ok(found[0].rank_explanation);

  // get_offering
  const detail = await rpc(registry.origin, 'tools/call', {
    name: 'get_offering',
    arguments: { node_id: 'org.opennodes.fixture', offering_id: 'echo-1' },
  });
  assert.equal(detail.body.result.structuredContent.binding.model_id, 'onp-echo-1');

  // estimate with a select step — the agent planning loop
  const est = await rpc(registry.origin, 'tools/call', {
    name: 'estimate',
    arguments: {
      steps: [
        { select: { modality: 'text', sort: 'price' }, est_input_tokens: 1000, est_output_tokens: 400 },
        { offering: 'org.opennodes.fixture/echo-1', est_input_tokens: 2000, est_output_tokens: 800 },
      ],
    },
  });
  const result = est.body.result.structuredContent;
  assert.equal(result.steps.length, 2);
  assert.ok(result.total.max > result.total.min);
  assert.ok(result.steps.every((s) => s.card_revision));

  // errors are tool-level (isError), not protocol-level
  const bad = await rpc(registry.origin, 'tools/call', {
    name: 'get_offering', arguments: { node_id: 'no.such', offering_id: 'nope' },
  });
  assert.equal(bad.body.result.isError, true);

  // unknown method -> JSON-RPC error
  const unknown = await rpc(registry.origin, 'no/such-method');
  assert.equal(unknown.body.error.code, -32601);
});
