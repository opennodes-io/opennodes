// `onp check`: a user's own verification of an offering, and how the gateway uses the result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureNode } from '@opennodes/fixture-node';
import { startRegistry } from '@opennodes/registry';
import { startGateway } from '@opennodes/cli/src/gateway.js';
import { checkOffering, saveCheck, loadChecks } from '@opennodes/cli/src/check.js';

async function listed(t, nodeOpts = {}) {
  const node = await startFixtureNode(nodeOpts);
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(async () => { await node.close(); await registry.close(); });
  const reg = await (await fetch(`${registry.origin}/v0/nodes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card_url: `${node.origin}/.well-known/open-node.json` }),
  })).json();
  node.setChallenge(reg.challenge.token);
  await fetch(`${registry.origin}${reg.challenge.verify}`, { method: 'POST' });
  const offering = (await (await fetch(`${registry.origin}/v0/offerings`)).json()).offerings[0];
  return { node, registry, offering };
}
const byName = (r) => Object.fromEntries(r.checks.map((c) => [c.name, c]));

test('check: an honest node passes the basics; a declared JSON mode that does not work is caught', async (t) => {
  const { offering } = await listed(t);
  const r = await checkOffering(offering, { maxUsd: 1 });
  const c = byName(r);
  for (const name of ['model listed', 'answers', 'usage reported', 'speed', 'context']) assert.equal(c[name].status, 'pass', `${name}: ${c[name].detail}`);
  assert.equal(c['json mode'].status, 'fail', 'the fixture echoes instead of returning JSON');
  assert.deepEqual(r.failed, ['json mode']);
  assert.equal(r.usable, true);
  assert.equal(r.ok, false);
  assert.ok(r.ttft_ms >= 0 && r.tps > 0);
  assert.ok(r.spent_usd > 0 && r.spent_usd < 1);
});

test('check: a node that claims more context than it holds fails the context test', async (t) => {
  const { offering } = await listed(t, { realContextTokens: 2048, claimContextTokens: 32768 });
  const c = byName(await checkOffering(offering, { maxUsd: 1, contextTokens: 8192 }));
  assert.equal(c.context.status, 'fail');
  assert.match(c.context.detail, /^8192 tokens: (prompt cut|the fact was lost)/);
});

test('check: the spend cap is respected', async (t) => {
  const { offering } = await listed(t);
  const priced = { ...offering, pricing: { ...offering.pricing, input_per_mtok: 1000, output_per_mtok: 1000 } };
  const r = await checkOffering(priced, { maxUsd: 0.0001 });
  const c = byName(r);
  assert.equal(c.answers.status, 'pass');
  for (const name of ['usage reported', 'speed', 'context']) assert.equal(c[name].status, 'skip', name);
});

test('gateway: onp/auto skips what failed your check and notes what passed', async (t) => {
  const { registry, offering } = await listed(t);
  const dir = mkdtempSync(join(tmpdir(), 'onp-checks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checksPath = join(dir, 'checks.json');
  const id = `${offering.node_id}/${offering.offering_id}`;
  const chat = (gw) => fetch(`${gw.origin}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'onp/auto', messages: [{ role: 'user', content: 'hi' }] }),
  });

  saveCheck({ offering: id, at: new Date().toISOString(), ok: false, usable: false, failed: ['answers'], checks: [] }, checksPath);
  const gw1 = await startGateway({ port: 0, registry: registry.origin, env: {}, checksPath });
  t.after(() => gw1.close());
  assert.equal((await chat(gw1)).status, 404, 'a node that failed your check is not auto-routed');

  saveCheck({ offering: id, at: new Date().toISOString(), ok: false, usable: true, failed: ['json mode'], ttft_ms: 120, tps: 40, checks: [] }, checksPath);
  assert.equal(loadChecks(checksPath)[id].usable, true);
  const gw2 = await startGateway({ port: 0, registry: registry.origin, env: {}, checksPath });
  t.after(() => gw2.close());
  assert.equal((await chat(gw2)).status, 200);
  const advice = await (await fetch(`${gw2.origin}/gateway/advice`)).json();
  assert.ok(advice.recommendations[0].reasons.some((x) => x === 'checked by you: issues: json mode'), JSON.stringify(advice.recommendations[0].reasons));
});
