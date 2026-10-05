// Namespace binding (ONP-3 §4): a node id is a reverse-DNS name, and only a host that
// controls that DNS name may register it. Without this an HTTP challenge proves control of
// *some* server, not of the namespace being claimed.

/** org.example.ai.box -> box.ai.example.org */
export const domainForNodeId = (nodeId) => String(nodeId).split('.').reverse().join('.').toLowerCase();

/**
 * True when `host` may serve the card and HTTP challenge for `nodeId`: the id's domain is the
 * host itself or a name beneath it (the owner of example.org controls org.example.*).
 * A *child* host never controls its parent's namespace (alice.github.io cannot claim io.github).
 */
export function hostControlsNamespace(host, nodeId) {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  const domain = domainForNodeId(nodeId);
  if (!h.includes('.')) return false;                       // a bare TLD / single label controls nothing
  return domain === h || domain.endsWith('.' + h);
}

/** Loopback / private literal hosts: only acceptable in dev mode (allowPrivateTargets). */
export function isPrivateHost(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\./.test(h) || /^10\./.test(h)
    || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}

/** Fixed-window in-memory rate limiter keyed by client address. limit <= 0 disables it. */
export function makeRateLimiter(limit, windowMs = 3_600_000) {
  const hits = new Map();
  return (key) => {
    if (!(limit > 0)) return true;
    const now = Date.now();
    const rec = hits.get(key);
    if (!rec || now - rec.start > windowMs) { hits.set(key, { start: now, n: 1 }); return true; }
    rec.n += 1;
    if (hits.size > 10_000) for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
    return rec.n <= limit;
  };
}
