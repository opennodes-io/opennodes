// Who may call the router (expert review of 18 Nov 2026, 4.11). There is no wildcard CORS.
//   - The router's own API (/router/*: peers, catalog, receipts, advice, reputation) always needs
//     the bearer token, and so does every request from another machine.
//   - The Ollama and OpenAI routes also serve local apps without a token, when the request comes from
//     this machine, its Host is a local name (so a DNS-rebinding page is refused), and any browser
//     Origin is a local page or one the user allowed (so another web page cannot use the router).
// The Host and Origin rules are shared with the gateway (@opennodes/core access.js).
import { isLoopbackAddress, isLoopbackBind, hostName, localAccess, bearerCheck, newToken } from '@opennodes/core';

export { isLoopbackAddress, isLoopbackBind, hostName, newToken };

export function accessPolicy({ token, allowOrigins = [], allowHosts = [] } = {}) {
  const { hostAllowed, originAllowed, crossSiteWithoutOrigin } = localAccess({ allowOrigins, allowHosts, what: 'the router' });
  const hasToken = bearerCheck(token);

  /**
   * Check one request. Returns null when it may proceed (after setting CORS headers for an allowed
   * browser origin), or { status, error } to refuse it; { preflight: true } for an allowed preflight.
   */
  function check(req, res) {
    const origin = req.headers.origin;
    const allowed = originAllowed(origin);
    if (allowed) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
      res.setHeader('access-control-expose-headers', 'onp-receipt, onp-pii-masked');
    }
    if (req.method === 'OPTIONS') {
      if (!allowed) return { status: 403, error: `origin ${origin ?? '(none)'} may not use this router (allow it with --allow-origin)` };
      res.setHeader('access-control-allow-methods', 'GET, HEAD, POST, DELETE');
      res.setHeader('access-control-allow-headers', 'authorization, content-type, onp-sensitive, onp-mask-pii');
      res.setHeader('access-control-max-age', '600');
      return { preflight: true };
    }
    if (hasToken(req)) return null;
    const path = new URL(req.url, 'http://router').pathname;
    if (path === '/router' || path.startsWith('/router/')) return { status: 401, error: 'the router API needs the router token: send "authorization: Bearer <token>"' };
    if (!isLoopbackAddress(req.socket?.remoteAddress)) return { status: 401, error: 'requests from other machines need the router token: send "authorization: Bearer <token>"' };
    if (!hostAllowed(req.headers.host)) return { status: 403, error: `Host "${req.headers.host ?? ''}" is not a local name, so the request may come from a web page (DNS rebinding); use 127.0.0.1 or localhost, allow the name with --allow-host, or send the router token` };
    if (origin != null && !allowed) return { status: 403, error: `origin ${origin} may not use this router (allow it with --allow-origin, or send the router token)` };
    if (crossSiteWithoutOrigin(req)) return { status: 403, error: 'cross-site browser requests may not use this router' };
    return null;
  }

  return { check, hasToken, hostAllowed, originAllowed };
}
