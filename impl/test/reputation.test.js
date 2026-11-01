// Passive reputation: what real calls through the gateway / router say about each offering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureNode } from '@opennodes/fixture-node';
import { startRegistry } from '@opennodes/registry';
import { startGateway } from '@opennodes/cli/src/gateway.js';
import { Reputation } from '@opennodes/cli/src/reputation.js';

test('reputation: too few calls say nothing; a failing streak benches; registry measurements win', () => {
  const rep = new Reputation();
  const o = { node_id: 'n', offering_id: 'o', observed: {} };
  rep.record('n/o', { ok: true, ms: 900, first_ms: 300 });
  rep.record('n/o', { ok: true, ms: 1100, first_ms: 500 });
  assert.equal(rep.summary('n/o'), null, 'two calls are not evidence');

  rep.record('n/o', { ok: true, ms: 1000, first_ms: 400 });
  const [filled] = rep.apply([o]);
  assert.equal(filled.observed.probe_success, 1);
  assert.deepEqual(filled.observed.ttft_ms, { p50: 400 });
  const [kept] = rep.apply([{ ...o, observed: { probe_success: 0.9, ttft_ms: { p50: 2000 } } }]);
  assert.equal(kept.observed.probe_success, 0.9, 'blind probes beat our own calls');
  assert.equal(kept.observed.ttft_ms.p50, 2000);

  for (let i = 0; i < 3; i++) rep.record('n/o', { ok: false, ms: 50, why: 'upstream 503' });
  const s = rep.summary('n/o');
  assert.equal(s.benched, true);
  assert.equal(s.failing_streak, 3);
  assert.equal(s.last_error, 'upstream 503');
  assert.deepEqual(rep.apply([o]), [], 'benched: out of the pool for now');
  assert.match(rep.describe('n/o'), /3 of 6 ok.*benched/);

  rep.record('n/o', { ok: true, ms: 800 });
  assert.equal(rep.summary('n/o').benched, false, 'one success ends the streak');
});

test('reputation: persists between runs, outcome and timing only', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'onp-rep-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'reputation.json');
  const a = new Reputation(path);
  for (let i = 0; i < 3; i++) a.record('n/o', { ok: true, ms: 100 + i });
  a.flush();
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, 'utf8'))['n/o'][0]).sort(), ['at', 'ms', 'ok']);
  assert.equal(new Reputation(path).summary('n/o').calls, 3);
});

test('gateway: a node that stops answering is benched, and advice says why', async (t) => {
  const node = await startFixtureNode();
  const registry = await startRegistry({ allowPrivateTargets: true });
  let nodeUp = true;
  t.after(async () => { if (nodeUp) await node.close(); await registry.close(); });
  const reg = await (await fetch(`${registry.origin}/v0/nodes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card_url: `${node.origin}/.well-known/open-node.json` }),
  })).json();
  node.setChallenge(reg.challenge.token);
  await fetch(`${registry.origin}${reg.challenge.verify}`, { method: 'POST' });

  const gw = await startGateway({ port: 0, registry: registry.origin, env: {}, checksPath: null });
  t.after(() => gw.close());
  const chat = () => fetch(`${gw.origin}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'onp/auto', messages: [{ role: 'user', content: 'hi' }] }),
  });
  const id = 'org.opennodes.fixture/echo-1';

  // advice is formed before a call is recorded: the 4th call is routed knowing about 3
  for (let i = 0; i < 4; i++) assert.equal((await chat()).status, 200);
  assert.equal(gw.reputation.summary(id).ok, 4);
  const advice = await (await fetch(`${gw.origin}/gateway/advice`)).json();
  assert.ok(advice.recommendations[0].reasons.some((r) => /^your calls: 3 of 3 ok/.test(r)), JSON.stringify(advice.recommendations[0].reasons));

  await node.close(); nodeUp = false;   // the node goes away
  for (let i = 0; i < 3; i++) assert.equal((await chat()).status, 502);
  assert.equal(gw.reputation.summary(id).benched, true);
  assert.equal((await chat()).status, 404, 'benched: onp/auto no longer tries it');

  const report = await (await fetch(`${gw.origin}/gateway/reputation`)).json();
  assert.equal(report.offerings[0].offering, id);
  assert.equal(report.offerings[0].calls, 7);
});
