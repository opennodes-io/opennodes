// Who may call the router (Two Minds review, 4.11). There is no wildcard CORS.
//   - The router's own API (/router/*: peers, catalog, receipts, advice, reputation) always needs
//     the bearer token, and so does every request from another machine.
//   - The Ollama and OpenAI routes also serve local apps without a token, when the request comes from
//     this machine, its Host is a local name (so a DNS-rebinding page is refused), and any browser
//     Origin is a local page or one the user allowed (so another web page cannot use the router).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';

export const newToken = () => randomBytes(24).toString('base64url');

const LOOPBACK = /^(127(\.\d{1,3}){3}|::1|::ffff:127(\.\d{1,3}){3}|0:0:0:0:0:0:0:1)$/i;
export const isLoopbackAddress = (address) => LOOPBACK.test(String(address ?? ''));
export const isLoopbackBind = (host) => String(host).toLowerCase() === 'localhost' || isLoopbackAddress(String(host).replace(/^\[|\]$/g, ''));

/** The name in a Host header, without the port or IPv6 brackets, lower-case. */
export function hostName(header) {
  const h = String(header ?? '').trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
  const parts = h.split(':');
  return parts.length === 2 ? parts[0] : h;
}

const isLocalName = (name) => name === 'localhost' || name.endsWith('.localhost') || isLoopbackAddress(name);
// Desktop app shells that Ollama also accepts by default. No web site can send these schemes. A file://
// page sends Origin "null", like a sandboxed iframe on any site, so it is never allowed.
const APP_SCHEMES = new Set(['app:', 'tauri:', 'vscode-webview:', 'vscode-file:']);

/** Origins (scheme://host[:port]) that may never be allowed: they would let any web page in. */
const NEVER = new Set(['*', 'null']);

export function accessPolicy({ token, allowOrigins = [], allowHosts = [] } = {}) {
  for (const o of allowOrigins) {
    if (NEVER.has(String(o).trim().toLowerCase())) throw new Error(`--allow-origin ${o} would let any web page use the router; name each origin instead`);
  }
  const origins = new Set(allowOrigins.map((o) => String(o).trim().replace(/\/$/, '')));
  const machine = hostname().toLowerCase();
  const hosts = new Set(['host.docker.internal', machine, `${machine}.local`, ...allowHosts.map((h) => hostName(h))]);
  const digest = (s) => createHash('sha256').update(String(s)).digest();
  const tokenDigest = digest(token);

  // 0.0.0.0 / :: as a Host: an Ollama client run with OLLAMA_HOST=0.0.0.0. A page served from there is still
  // refused by the Origin check, which never treats 0.0.0.0 as a local page.
  const hostAllowed = (header) => { const name = hostName(header); return isLocalName(name) || name === '0.0.0.0' || name === '::' || hosts.has(name); };
  const originAllowed = (origin) => {
    if (origin == null) return false;
    if (origins.has(origin)) return true;
    try {
      const u = new URL(origin);
      if (APP_SCHEMES.has(u.protocol)) return true;
      return (u.protocol === 'http:' || u.protocol === 'https:') && isLocalName(u.hostname.replace(/^\[|\]$/g, ''));
    } catch { return false; }
  };
  const hasToken = (req) => {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(String(req.headers.authorization ?? ''));
    return Boolean(m) && timingSafeEqual(digest(m[1]), tokenDigest);
  };

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
    if (origin == null && String(req.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return { status: 403, error: 'cross-site browser requests may not use this router' };
    return null;
  }

  return { check, hasToken, hostAllowed, originAllowed };
}
