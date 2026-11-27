// Keys are chosen by the JWS kid and a JWKS is fetched again once when no cached key verifies, so a
// node can rotate its key (review 4.2). Only EdDSA is accepted (ONP-2 §8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  generateKeypair, signJson, verifyJws, verifyJwsWithJwks, jwksCache, signCard, verifyCardWithJwks, keyFromJwk,
} from '@opennodes/core';

const jwk = (kp, kid) => ({ ...kp.publicJwk, kid });
const b64u = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

test('verifyJwsWithJwks picks the key by kid, not keys[0]', () => {
  const old = generateKeypair(), cur = generateKeypair();
  const jws = signJson({ n: 1 }, cur.privateKey, 'k2');
  const { payload, jwk: used } = verifyJwsWithJwks(jws, { keys: [jwk(old, 'k1'), jwk(cur, 'k2')] });
  assert.deepEqual(payload, { n: 1 });
  assert.equal(used.kid, 'k2');
  // a kid the JWKS does not carry is named in the error
  assert.throws(() => verifyJwsWithJwks(signJson({}, cur.privateKey, 'k9'), { keys: [jwk(old, 'k1')] }), /kid k9/);
  assert.throws(() => verifyJwsWithJwks(jws, { keys: [] }), /no key in jwks/);
});

test('only EdDSA is accepted: none and HMAC are refused before any key is used', () => {
  const kp = generateKeypair();
  const body = b64u({ amount: 0 });
  assert.throws(() => verifyJws(`${b64u({ alg: 'none' })}.${body}.`, keyFromJwk(kp.publicJwk)), /not allowed/);
  const h = b64u({ alg: 'HS256', kid: 'onp-1' });
  const mac = createHmac('sha256', JSON.stringify(kp.publicJwk)).update(`${h}.${body}`).digest('base64url');
  assert.throws(() => verifyJwsWithJwks(`${h}.${body}.${mac}`, { keys: [jwk(kp, 'onp-1')] }), /not allowed/);
});

test('jwksCache: a rotated key is picked up with one re-fetch; a bad signature costs one fetch, not a loop', async () => {
  const old = generateKeypair(), cur = generateKeypair();
  let published = { keys: [jwk(old, 'k1')] };
  let fetches = 0;
  const cache = jwksCache({ fetchJwks: async () => { fetches++; return published; } });
  const o = 'https://node.example';
  assert.deepEqual(await cache.verify(o, signJson({ r: 1 }, old.privateKey, 'k1')), { r: 1 });
  assert.equal(fetches, 1);
  await cache.verify(o, signJson({ r: 2 }, old.privateKey, 'k1'));
  assert.equal(fetches, 1, 'a known key is served from the cache');
  published = { keys: [jwk(cur, 'k2')] };            // the node rotates
  assert.deepEqual(await cache.verify(o, signJson({ r: 3 }, cur.privateKey, 'k2')), { r: 3 });
  assert.equal(fetches, 2, 'one re-fetch on the kid miss');
  // the same kid, a bad signature: one re-fetch, then the error
  const forged = signJson({ r: 4 }, generateKeypair().privateKey, 'k2');
  await assert.rejects(cache.verify(o, forged), /signature invalid/);
  assert.equal(fetches, 3);
});

test('jwksCache: entries expire after ttlMs', async () => {
  const kp = generateKeypair();
  let t = 0, fetches = 0;
  const cache = jwksCache({ ttlMs: 1000, now: () => t, fetchJwks: async () => { fetches++; return { keys: [jwk(kp, 'a')] }; } });
  await cache.verify('o', signJson({}, kp.privateKey, 'a'));
  t = 999; await cache.verify('o', signJson({}, kp.privateKey, 'a'));
  assert.equal(fetches, 1);
  t = 1000; await cache.verify('o', signJson({}, kp.privateKey, 'a'));
  assert.equal(fetches, 2);
});

test('verifyCardWithJwks: by kid among several keys; a card no published key signed is refused', () => {
  const old = generateKeypair(), cur = generateKeypair();
  const card = signCard({ onp: '0.1', node: { id: 'org.example.n' } }, cur.privateKey, 'k2');
  assert.equal(verifyCardWithJwks(card, { keys: [jwk(old, 'k1'), jwk(cur, 'k2')] }).kid, 'k2');
  // a kid that is absent still verifies with another key the origin publishes (kids are a hint)
  assert.equal(verifyCardWithJwks(card, { keys: [jwk(old, 'k1'), jwk(cur, 'x')] }).kid, 'x');
  assert.throws(() => verifyCardWithJwks(card, { keys: [jwk(old, 'k2')] }));
  assert.throws(() => verifyCardWithJwks({ ...card, signatures: [] }, { keys: [jwk(cur, 'k2')] }), /no signatures/);
});
