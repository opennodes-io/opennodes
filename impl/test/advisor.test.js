// Advisor (ONP-3 §5b): feature extraction, deterministic ranking with explanations,
// the registry endpoint, the stdio-MCP privacy path, and gateway onp/auto routing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFeatures, recommend, detectLanguage } from '@opennodes/core';
import { startFixtureNode } from '@opennodes/fixture-node';
import { startRegistry } from '@opennodes/registry';
import { startGateway } from '@opennodes/cli/src/gateway.js';

const offering = (over) => ({
  node_id: 'org.example.a', offering_id: 'm', tier: 'verified', source: 'registration', card_revision: 'r1',
  modality: 'text', model: { name: 'M', artifact: 'hf:x/m', params_b: 70 },
  serving: { context_window: 128000, supports: ['streaming', 'tool_calls', 'json_mode'], languages: [{ lang: 'en', grade: 'native' }, { lang: 'pl', grade: 'strong' }] },
  binding: { profile: 'onp.openai.chat/v1', model_id: 'm' },
  pricing: { currency: 'USD', input_per_mtok: 1.0, output_per_mtok: 3.0, schemes: ['prepaid'] },
  data_policy: { retention: 'none', training_on_inputs: false },
  observed: { probe_success: 1, probes: 4, ttft_ms: { p50: 300 }, tps: 80, availability: null },
  endpoints: { openai: 'https://a.example/v1' },
  ...over,
});

test('extractFeatures: task class, language, needs, sizes — never the text', () => {
  const f = extractFeatures('Extract all invoice line items from this PDF as JSON with a strict schema.', { attachments: [{ chars: 40000 }] });
  assert.equal(f.task_class, 'extraction');
  assert.equal(f.needs.json, true);
  assert.equal(f.language, 'en');
  assert.ok(f.est_input_tokens > 10000);
  assert.ok(!JSON.stringify(f).includes('invoice line items'));

  const pl = extractFeatures('Proszę przetłumaczyć ten dokument i nie zmieniać formatowania, czy to jest możliwe?');
  assert.equal(pl.language, 'pl');
  assert.equal(detectLanguage('Будь ласка, перекладіть цей текст'), 'uk');

  const hard = extractFeatures('Prove that the algorithm is O(n log n) and derive the recurrence step by step.');
  assert.equal(hard.needs.reasoning, 'high');
  const agent = extractFeatures('Open the website https://example.org, click login and fill in the form, then run the tests.');
  assert.equal(agent.task_class, 'agentic');
  assert.ok(agent.needs.tool_categories.includes('browser'));
  const sensitive = extractFeatures('Summarize this patient medical record: john.doe@example.com');
  assert.equal(sensitive.privacy, 'sensitive');
});

test('recommend: hard filters reject, weights explain, cheap wins on extraction, strong wins on reasoning', () => {
  const strong = offering({ node_id: 'org.example.strong', model: { name: 'Strong', artifact: 'hf:x/strong', params_b: 400 }, pricing: { currency: 'USD', input_per_mtok: 5, output_per_mtok: 15, schemes: ['prepaid'] } });
  const cheap = offering({ node_id: 'org.example.cheap', model: { name: 'Cheap', artifact: 'hf:x/cheap', params_b: 8 }, pricing: { currency: 'USD', input_per_mtok: 0.1, output_per_mtok: 0.3, schemes: ['prepaid'] } });
  const noTools = offering({ node_id: 'org.example.notools', serving: { context_window: 128000, supports: ['streaming'] } });
  const tiny = offering({ node_id: 'org.example.tiny', serving: { context_window: 4096, supports: ['streaming', 'tool_calls', 'json_mode'] } });
  const leaky = offering({ node_id: 'org.example.leaky', data_policy: { retention: '30d', training_on_inputs: true } });
  const all = [strong, cheap, noTools, tiny, leaky];

  const ext = recommend(all, extractFeatures('Classify these 500 support tickets by category, output as JSON.', { attachments: [{ chars: 60000 }] }), { limit: 5 });
  assert.equal(ext.rejected.capabilities, 1, 'no json_mode → rejected');
  assert.equal(ext.rejected.context, 1, '4k window → rejected');
  assert.equal(ext.recommendations[0].node_id, 'org.example.cheap');
  assert.ok(ext.recommendations[0].reasons.some((r) => /price-led/.test(r)));
  assert.ok(ext.recommendations[0].estimate.max > 0 && ext.recommendations[0].card_revision === 'r1');

  const hard = recommend(all, extractFeatures('Prove the theorem rigorously, step by step, and derive the bound.'), { limit: 5 });
  assert.equal(hard.recommendations[0].node_id, 'org.example.strong');
  assert.ok(hard.scenario && hard.scenario.name === 'triage-then-expert');

  const priv = recommend(all, extractFeatures('Summarize this confidential patient record.'), { limit: 5 });
  assert.equal(priv.rejected.data_policy, 1);
  assert.ok(!priv.recommendations.some((r) => r.node_id === 'org.example.leaky'));

  // determinism: same inputs → identical output
  assert.deepEqual(recommend(all, hard.features, { limit: 5 }), hard);
});

test('registry /v0/recommend, MCP recommend, and gateway onp/auto route to the fixture', async (t) => {
  const node = await startFixtureNode();
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(async () => { await node.close(); await registry.close(); });
  const reg = await (await fetch(`${registry.origin}/v0/nodes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card_url: `${node.origin}/.well-known/open-node.json` }),
  })).json();
  node.setChallenge(reg.challenge.token);
  await fetch(`${registry.origin}${reg.challenge.verify}`, { method: 'POST' });

  // task text path
  const r1 = await (await fetch(`${registry.origin}/v0/recommend`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: 'Reply with a short greeting as JSON.', policy: { limit: 3 } }),
  })).json();
  assert.equal(r1.recommendations[0].offering, 'org.opennodes.fixture/echo-1');
  assert.equal(r1.recommendations[0].hardware.accelerators[0].type, 'CPU');
  assert.ok(r1.recommendations[0].estimate.max > 0);

  // features-only path (what the stdio MCP server sends — no prompt)
  const features = extractFeatures('Reply with a short greeting as JSON.');
  const r2 = await (await fetch(`${registry.origin}/v0/recommend`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ features }),
  })).json();
  assert.equal(r2.recommendations[0].offering, 'org.opennodes.fixture/echo-1');

  // MCP tool
  const mcp = await (await fetch(`${registry.origin}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'recommend', arguments: { task: 'say hi' } } }),
  })).json();
  assert.equal(mcp.result.structuredContent.recommendations[0].node_id, 'org.opennodes.fixture');

  // gateway: onp/auto is listed and routes by advice, with the decision inspectable
  const gw = await startGateway({ port: 0, registry: registry.origin });
  t.after(() => gw.close());
  const ids = (await (await fetch(`${gw.origin}/v1/models`)).json()).data.map((m) => m.id);
  assert.ok(ids.includes('onp/auto') && ids.includes('onp/auto-cheap'));
  const chat = await (await fetch(`${gw.origin}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'onp/auto-cheap', messages: [{ role: 'user', content: 'ping' }] }),
  })).json();
  assert.match(chat.choices[0].message.content, /^echo: ping/);
  assert.equal(chat.model, 'onp/auto-cheap');
  const advice = await (await fetch(`${gw.origin}/gateway/advice`)).json();
  assert.equal(advice.recommendations[0].offering, 'org.opennodes.fixture/echo-1');
  assert.ok(!JSON.stringify(advice.features).includes('ping'));
});
