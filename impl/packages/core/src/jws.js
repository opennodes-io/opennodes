// Compact JWS (EdDSA/Ed25519) over detached JSON payloads, using node:crypto only.
import { generateKeyPairSync, sign as edSign, verify as edVerify, createPublicKey, createPrivateKey, createHash } from 'node:crypto';

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

// RFC 7638: the members that identify a public key, by key type.
const THUMBPRINT_MEMBERS = { OKP: ['crv', 'kty', 'x'], EC: ['crv', 'kty', 'x', 'y'], RSA: ['e', 'kty', 'n'] };

/**
 * JWK thumbprint (RFC 7638, SHA-256, base64url): a short, stable name for a public key. Clients pin
 * a LAN peer by the thumbprint of the key that signs its card (ONP-3 §5b).
 */
export function jwkThumbprint(jwk) {
  const members = THUMBPRINT_MEMBERS[jwk?.kty];
  if (!members || members.some((m) => typeof jwk[m] !== 'string')) throw new Error(`cannot take the thumbprint of a ${jwk?.kty ?? 'malformed'} key`);
  const canonical = '{' + members.map((m) => `${JSON.stringify(m)}:${JSON.stringify(jwk[m])}`).join(',') + '}';
  return createHash('sha256').update(canonical).digest('base64url');
}

/** Sign a JSON payload; returns compact JWS string header.payload.signature. */
export function signJson(payload, privateKey, kid = 'onp-1') {
  const header = b64u(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid }));
  const body = b64u(stableStringify(payload));
  const sig = edSign(null, Buffer.from(`${header}.${body}`), privateKey);
  return `${header}.${body}.${b64u(sig)}`;
}

/**
 * The JWS algorithms ONP accepts (ONP-2 §8): EdDSA over Ed25519 only. Anything else, `none` and the
 * HMAC family included, is refused before any key is used.
 */
export const ALLOWED_JWS_ALGS = Object.freeze(['EdDSA']);

/** Verify a compact JWS against a public key; returns the decoded payload or throws. */
export function verifyJws(jws, publicKey) {
  const parts = String(jws).split('.');
  if (parts.length !== 3) throw new Error('malformed JWS');
  const [header, body, sig] = parts;
  let alg;
  try { alg = JSON.parse(fromB64u(header).toString('utf8'))?.alg; } catch { throw new Error('malformed JWS header'); }
  if (!ALLOWED_JWS_ALGS.includes(alg)) throw new Error(`JWS alg ${JSON.stringify(alg)} is not allowed`);
  if (publicKey?.asymmetricKeyType !== 'ed25519') throw new Error('JWS key is not an Ed25519 public key');
  const ok = edVerify(null, Buffer.from(`${header}.${body}`), publicKey, fromB64u(sig));
  if (!ok) throw new Error('JWS signature invalid');
  return JSON.parse(fromB64u(body).toString('utf8'));
}

export function decodeJwsHeader(jws) {
  return JSON.parse(fromB64u(String(jws).split('.')[0]).toString('utf8'));
}

/** At most this many keys of one JWKS are tried for one signature. */
const MAX_JWKS_KEYS = 8;

/**
 * The keys of a JWKS to try for a signature with this `kid`: the keys that carry the kid first, then the
 * others. Any key the origin publishes may sign for it; the kid only says where to start, so a node that
 * rotates keys or omits kids still verifies. Entries that are not objects are skipped.
 */
export function jwksCandidates(jwks, kid) {
  const keys = (Array.isArray(jwks?.keys) ? jwks.keys : []).filter((k) => k && typeof k === 'object');
  const ordered = kid ? [...keys.filter((k) => k.kid === kid), ...keys.filter((k) => k.kid !== kid)] : keys;
  return ordered.slice(0, MAX_JWKS_KEYS);
}

/**
 * Verify a compact JWS against an origin's JWKS: the key named by the header's `kid` first, then the
 * other keys. Returns { payload, jwk }; throws when no key verifies it (or the JWKS has none).
 */
export function verifyJwsWithJwks(jws, jwks) {
  let kid;
  try { kid = decodeJwsHeader(jws)?.kid; } catch { throw new Error('malformed JWS header'); }
  const candidates = jwksCandidates(jwks, kid);
  if (!candidates.length) throw new Error('no key in jwks');
  let last;
  for (const jwk of candidates) {
    let key;
    try { key = keyFromJwk(jwk); } catch (err) { last = err; continue; }
    try { return { payload: verifyJws(jws, key), jwk }; } catch (err) { last = err; }
  }
  if (kid && !candidates.some((k) => k.kid === kid)) throw new Error(`no key in jwks for kid ${kid}`);
  throw last ?? new Error('JWS signature invalid');
}

/**
 * A per-origin JWKS cache for verifying receipts. A key is chosen by the JWS `kid`. When no cached key
 * verifies (a kid the cache has not seen, or a failed verify), the JWKS is fetched again once before
 * giving up, so a node can rotate its key without clients holding the old JWKS for good. Entries also
 * expire after `ttlMs`.
 *   fetchJwks(origin) -> Promise<jwks>
 */
export function jwksCache({ fetchJwks, ttlMs = 60 * 60 * 1000, now = Date.now } = {}) {
  const entries = new Map();   // origin -> { at, jwks }
  const stale = (e) => !e || now() - e.at >= ttlMs;
  async function load(origin) {
    const jwks = await fetchJwks(origin);
    entries.set(origin, { at: now(), jwks });
    return jwks;
  }
  const get = async (origin) => (stale(entries.get(origin)) ? load(origin) : entries.get(origin).jwks);
  /** Verify a compact JWS from `origin`; returns the decoded payload, or throws. */
  async function verify(origin, jws) {
    const justFetched = stale(entries.get(origin));
    const jwks = await get(origin);
    try { return verifyJwsWithJwks(jws, jwks).payload; } catch (err) {
      if (justFetched) throw err;                 // a second fetch now would say the same
      return verifyJwsWithJwks(jws, await load(origin)).payload;
    }
  }
  return { get, verify, clear: (origin) => (origin ? entries.delete(origin) : entries.clear()) };
}
