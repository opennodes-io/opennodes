// Who may call a local OpenNodes server (the Ollama router and the gateway; expert review of 18 Nov 2026, 4.11).
// A server bound to loopback is still reachable from every web page the user opens: a page can send
// cross-site "simple" requests, and a DNS-rebinding page (attacker.example re-resolved to 127.0.0.1)
// can also read the replies. These helpers let a server refuse both without a token:
//   - the Host header must be a local name, which a rebinding page cannot send (its Host is its own name);
//   - a browser Origin must be a local page, a desktop app shell, or one the user allowed by name.
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

/** A random bearer token for a local server's own API. */
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

/** localhost, *.localhost (RFC 6761: always this machine) and loopback addresses. */
export const isLocalName = (name) => name === 'localhost' || name.endsWith('.localhost') || isLoopbackAddress(name);

// Desktop app shells that Ollama also accepts by default. No web site can send these schemes. A file://
// page sends Origin "null", like a sandboxed iframe on any site, so it is never allowed.
export const APP_SCHEMES = new Set(['app:', 'tauri:', 'vscode-webview:', 'vscode-file:']);

/** Origins that may never be allowed: they would let any web page in. */
const NEVER = new Set(['*', 'null']);

/**
 * The Host and Origin rules for one local server. allowOrigins: exact origins (scheme://host[:port]) the
 * user allowed besides local pages and app shells; allowHosts: extra Host names, such as a reverse proxy's.
 * `flag` names the option in error messages.
 */
export function localAccess({ allowOrigins = [], allowHosts = [], flag = '--allow-origin', what = 'the server' } = {}) {
  for (const o of allowOrigins) {
    if (NEVER.has(String(o).trim().toLowerCase())) throw new Error(`${flag} ${o} would let any web page use ${what}; name each origin instead`);
  }
  const origins = new Set(allowOrigins.map((o) => String(o).trim().replace(/\/$/, '')));
  const machine = hostname().toLowerCase();
  const hosts = new Set(['host.docker.internal', machine, `${machine}.local`, ...allowHosts.map((h) => hostName(h))]);

  // 0.0.0.0 / :: as a Host: a client pointed at 0.0.0.0 (e.g. OLLAMA_HOST=0.0.0.0). A page served from there is
  // still refused by the Origin check, which never treats 0.0.0.0 as a local page.
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
  /** A browser request with no Origin that the browser itself marks cross-site (a no-cors GET, say). */
  const crossSiteWithoutOrigin = (req) => req.headers.origin == null && String(req.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site';
  return { hostAllowed, originAllowed, crossSiteWithoutOrigin };
}

/** (req) => true when it carries "authorization: Bearer <token>", compared in constant time. */
export function bearerCheck(token) {
  const digest = (s) => createHash('sha256').update(String(s)).digest();
  const want = digest(token);
  return (req) => {
    if (token == null || token === '') return false;
    const m = /^Bearer\s+(.+?)\s*$/i.exec(String(req.headers.authorization ?? ''));   // a chosen token may contain spaces
    return Boolean(m) && timingSafeEqual(digest(m[1]), want);
  };
}

/**
 * Is this a JSON request? application/json, with parameters such as "; charset=utf-8", any case.
 * A browser can send text/plain, form or multipart bodies cross-site without asking first (a "simple"
 * request); application/json always needs a CORS preflight, which a server can refuse.
 */
export function isJsonContentType(header) {
  const type = String(header ?? '').split(';')[0].trim().toLowerCase();
  return type === 'application/json';
}
