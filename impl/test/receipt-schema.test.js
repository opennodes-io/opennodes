// The receipt is a compact JWS over the JCS payload, under the card's algorithm rule, and its payload
// matches schemas/receipt.schema.json (ONP-5 §5, ONP-2 §8; review H4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { startFixtureNode } from '@opennodes/fixture-node';
import { decodeJwsHeader, verifyJwsWithJwks, stableStringify, ALLOWED_JWS_ALGS } from '@opennodes/core';

const schema = JSON.parse(readFileSync(fileURLToPath(new URL('../../schemas/receipt.schema.json', import.meta.url)), 'utf8'));
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

test('a fixture receipt is a compact EdDSA JWS over the JCS payload and matches the receipt schema', async (t) => {
  const node = await startFixtureNode();
  t.after(() => node.close());
  const res = await fetch(`${node.origin}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'onp-echo-1', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 200);
  const jws = res.headers.get('onp-receipt');
  assert.equal(jws.split('.').length, 3, 'compact serialization, payload attached');
  assert.ok(ALLOWED_JWS_ALGS.includes(decodeJwsHeader(jws).alg));
  const jwks = await (await fetch(`${node.origin}/.well-known/jwks.json`)).json();
  const { payload } = verifyJwsWithJwks(jws, jwks);
  assert.equal(Buffer.from(jws.split('.')[1], 'base64url').toString('utf8'), stableStringify(payload), 'the payload bytes are its JCS form');
  assert.ok(validate(payload), JSON.stringify(validate.errors));
});

test('the receipt schema refuses a receipt without a request hash or with a negative amount', () => {
  const ok = {
    receipt_id: 'r_1', node_id: 'org.example.n', offering_id: 'm', card_revision: '2026-11-24T00:00:00Z',
    request_hash: `sha256:${'a'.repeat(64)}`, usage: { prompt_tokens: 1, completion_tokens: 2 },
    amount: { currency: 'USD', value: 0 }, issued_at: '2026-11-24T00:00:01Z',
  };
  assert.ok(validate(ok));
  const { request_hash, ...noHash } = ok;
  assert.equal(validate(noHash), false);
  assert.equal(validate({ ...ok, amount: { currency: 'USD', value: -1 } }), false);
});
