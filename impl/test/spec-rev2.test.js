// Draft 0.1 revision 2 (spec/CHANGES.md): minor-version acceptance and open vocabularies,
// region and language containment, and the Stage A card-consistency check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCard, regionWithin, residencyWithin, recommend, extractFeatures } from '@opennodes/core';
import { startFixtureNode } from '@opennodes/fixture-node';
import { startRegistry } from '@opennodes/registry';
import { cardConsistency } from '@opennodes/registry/src/probes.js';
import { langMatches } from '@opennodes/registry/src/search.js';

const card = (over = {}, offeringOver = {}) => ({
  onp: '0.1',
  revision: '2026-10-31T00:00:00Z',
  node: { id: 'ca.example.node', name: 'Example', operator: { name: 'Example Inc.' }, regions: ['CA-QC'] },
  endpoints: { openai: 'https://node.example.ca/v1', health: 'https://node.example.ca/onp/health' },
  offerings: [{
    offering_id: 'm1', modality: 'text',
    model: { name: 'M1', artifact: 'hf:example/m1' },
    serving: { languages: [{ lang: 'en', grade: 'native' }] },
    binding: { profile: 'onp.openai.chat/v1', model_id: 'm1' },
    pricing: { currency: 'CAD', schemes: ['prepaid'] },
    data_policy: { retention: 'none', training_on_inputs: false, region_pinning: ['CA'] },
    ...offeringOver,
  }],
  payment: { schemes: [{ scheme: 'prepaid' }] },
  ...over,
});

test('later 0.x minors and unknown vocabulary values validate (ONP-1 §5)', () => {
  assert.deepEqual(validateCard(card()), []);
  const extended = card(
    { onp: '0.2', payment: { schemes: [{ scheme: 'contract' }, { scheme: 'prepaid' }] } },
    {
      modality: 'hologram',
      serving: { supports: ['streaming', 'logprobs', 'com.example.magic'], languages: [{ lang: 'fr-CA', grade: 'strong' }] },
      pricing: { currency: 'CAD', schemes: ['contract'] },
      capacity: { aggregate_output_tps: { p50: 4000, basis: 'claimed' }, max_concurrency: 64, rate_limits: { rpm: 600 } },
    },
  );
  assert.deepEqual(validateCard(extended), []);
});

test('other majors, malformed tokens and unbounded ephemeral retention are rejected', () => {
  assert.ok(validateCard(card({ onp: '1.0' })).length > 0);
  assert.ok(validateCard(card({}, { modality: 'Text Gen' })).length > 0);
  assert.ok(validateCard(card({}, { data_policy: { retention: 'ephemeral' } })).length > 0);
  assert.deepEqual(validateCard(card({}, { data_policy: { retention: 'ephemeral', retention_max_seconds: 3600 } })), []);
});

test('region containment: a code contains its subdivisions, case-insensitively (ONP-2 §3)', () => {
  assert.equal(regionWithin('CA-QC', 'CA'), true);
  assert.equal(regionWithin('ca-qc', 'CA'), true);
  assert.equal(regionWithin('CA', 'CA-QC'), false);
  assert.equal(regionWithin('eu-central', 'EU'), true);
  assert.equal(regionWithin('CAN', 'CA'), false);
  assert.equal(residencyWithin(['CA-QC', 'CA-ON'], 'CA'), true);
  assert.equal(residencyWithin(['CA-QC', 'US'], 'CA'), false, 'one location outside breaks residency');
  assert.equal(residencyWithin([], 'CA'), false, 'no declared location proves nothing');
  assert.equal(langMatches('fr-CA', 'fr'), true);
  assert.equal(langMatches('fr', 'fr-CA'), false);
});

test('advisor region policy uses containment and requires every pinned location inside', () => {
  const base = { tier: 'verified', source: 'registration', card_revision: 'r1', modality: 'text',
    model: { name: 'M', artifact: 'hf:x/m', params_b: 70 }, serving: { context_window: 128000, supports: ['streaming'] },
    binding: { profile: 'onp.openai.chat/v1', model_id: 'm' },
    pricing: { currency: 'CAD', input_per_mtok: 1, output_per_mtok: 3, schemes: ['prepaid'] },
    observed: { probe_success: 1, probes: 4, ttft_ms: null, tps: null, availability: null }, endpoints: { openai: 'https://a.example/v1' } };
  const qc = { ...base, node_id: 'ca.example.qc', offering_id: 'qc', data_policy: { retention: 'none', region_pinning: ['CA-QC'] } };
  const split = { ...base, node_id: 'ca.example.split', offering_id: 'split', data_policy: { retention: 'none', region_pinning: ['CA-QC', 'US'] } };
  const r = recommend([qc, split], extractFeatures('Summarize this memo.'), { region: 'CA', limit: 5 });
  assert.deepEqual(r.recommendations.map((x) => x.node_id), ['ca.example.qc']);
  assert.equal(r.rejected.region, 1);
});

test('Stage A card consistency: data_policy present, offering schemes declared by the node', () => {
  assert.deepEqual(cardConsistency(card()), []);
  const bad = card({}, { data_policy: undefined, pricing: { currency: 'CAD', schemes: ['prepaid', 'x402'] } });
  const problems = cardConsistency(bad);
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => /no data_policy/.test(p)));
  assert.ok(problems.some((p) => /x402/.test(p)));
});

test('registry: Stage A records card-consistency; search filters by region and language', async (t) => {
  const node = await startFixtureNode();
  const registry = await startRegistry({ allowPrivateTargets: true });
  t.after(async () => { await node.close(); await registry.close(); });

  const reg = await (await fetch(`${registry.origin}/v0/nodes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card_url: `${node.origin}/.well-known/open-node.json` }),
  })).json();
  node.setChallenge(reg.challenge.token);
  const verify = await (await fetch(`${registry.origin}${reg.challenge.verify}`, { method: 'POST' })).json();
  assert.equal(verify.state, 'community', JSON.stringify(verify.stage_a));
  assert.ok(verify.stage_a.results.some((r) => r.kind === 'card-consistency' && r.ok));

  const search = async (qs) => (await (await fetch(`${registry.origin}/v0/offerings?${qs}`)).json()).offerings;
  // The fixture pins data to legacy "eu"; "EU" matches case-insensitively, "CA" does not.
  assert.equal((await search('region=EU')).length, 1);
  assert.equal((await search('region=CA')).length, 0);
  assert.equal((await search('lang=en')).length, 1);
  assert.equal((await search('lang=en-GB')).length, 0);
});
