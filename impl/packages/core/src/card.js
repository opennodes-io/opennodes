// Node Card validation, canonical signing payload, sign & verify (ONP-2).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { signJson, verifyJws, stableStringify } from './jws.js';

const schemaPath = fileURLToPath(new URL('../../../../schemas/open-node.schema.json', import.meta.url));
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

const ajv = new Ajv2020.default({ allErrors: true, strict: false });
addFormats.default(ajv);
const validator = ajv.compile(schema);

/** Validate a card against the normative schema. Returns [] or a list of error strings. */
export function validateCard(card) {
  if (validator(card)) return [];
  return (validator.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`);
}

/** The signing payload is the card without `signatures`, stably serialized. */
export function cardSigningPayload(card) {
  const { signatures, ...rest } = card;
  return rest;
}

export function signCard(card, privateKey, kid = 'onp-1') {
  const jws = signJson(cardSigningPayload(card), privateKey, kid);
  const [protectedHeader, , signature] = jws.split('.');
  return { ...card, signatures: [{ protected: protectedHeader, signature, kid, _jws: jws }] };
}

/** Verify the first signature of a card against a public key. Throws on mismatch. */
export function verifyCardSignature(card, publicKey) {
  const sig = card.signatures?.[0];
  if (!sig) throw new Error('card has no signatures');
  const payloadB64 = Buffer.from(stableStringify(cardSigningPayload(card))).toString('base64url');
  const jws = sig._jws ?? `${sig.protected}.${payloadB64}.${sig.signature}`;
  const decoded = verifyJws(jws, publicKey);
  if (stableStringify(decoded) !== stableStringify(cardSigningPayload(card))) {
    throw new Error('card signature payload does not match card content');
  }
  return true;
}
