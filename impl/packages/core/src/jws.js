// Compact JWS (EdDSA/Ed25519) over detached JSON payloads, using node:crypto only.
import { generateKeyPairSync, sign as edSign, verify as edVerify, createPublicKey, createPrivateKey } from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(s, 'base64url');

/** Deterministic JSON: object keys sorted recursively, arrays kept in order. */
export function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function generateKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey,
    privateKey,
    publicJwk: publicKey.export({ format: 'jwk' }),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

export function keyFromPem(pem) {
  return createPrivateKey(pem);
}

/** Rebuild the full keypair shape from a stored PKCS8 PEM (persistent identities). */
export function keypairFromPem(pem) {
  const privateKey = createPrivateKey(pem);
  const publicKey = createPublicKey(privateKey);
  return { publicKey, privateKey, publicJwk: publicKey.export({ format: 'jwk' }), privatePem: pem };
}

export function keyFromJwk(jwk) {
  return createPublicKey({ key: jwk, format: 'jwk' });
}

/** Sign a JSON payload; returns compact JWS string header.payload.signature. */
export function signJson(payload, privateKey, kid = 'onp-1') {
  const header = b64u(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid }));
  const body = b64u(stableStringify(payload));
  const sig = edSign(null, Buffer.from(`${header}.${body}`), privateKey);
  return `${header}.${body}.${b64u(sig)}`;
}

/** Verify a compact JWS against a public key; returns the decoded payload or throws. */
export function verifyJws(jws, publicKey) {
  const parts = jws.split('.');
  if (parts.length !== 3) throw new Error('malformed JWS');
  const [header, body, sig] = parts;
  const ok = edVerify(null, Buffer.from(`${header}.${body}`), publicKey, fromB64u(sig));
  if (!ok) throw new Error('JWS signature invalid');
  return JSON.parse(fromB64u(body).toString('utf8'));
}

export function decodeJwsHeader(jws) {
  return JSON.parse(fromB64u(jws.split('.')[0]).toString('utf8'));
}
