// Minimal HTTP server helper: path-pattern routing, JSON bodies, RFC 9457 problems.
import { createServer } from 'node:http';

export function problem(res, status, type, detail) {
  res.writeHead(status, { 'content-type': 'application/problem+json' });
  res.end(JSON.stringify({ type: `https://opennodes.org/problems/${type}`, title: type, status, detail }));
}

export function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export async function readJson(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Router: routes are [method, pattern, handler]; pattern segments starting with ':' capture params.
 * Handler signature: (req, res, { params, query, url }).
 * opts.cors enables permissive CORS (public read APIs and inference nodes serving
 * browser clients — ONP headers and receipts are exposed to cross-origin pages).
 */
export function createApp(routes, { cors = false } = {}) {
  return createServer(async (req, res) => {
    if (cors) {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'content-type, authorization, onp-offering, onp-card-revision');
      res.setHeader('access-control-expose-headers', 'onp-receipt');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    }
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const segments = url.pathname.split('/').filter(Boolean);
    for (const [method, pattern, handler] of routes) {
      if (req.method !== method) continue;
      const patSegs = pattern.split('/').filter(Boolean);
      if (patSegs.length !== segments.length) continue;
      const params = {};
      let match = true;
      for (let i = 0; i < patSegs.length; i++) {
        if (patSegs[i].startsWith(':')) params[patSegs[i].slice(1)] = decodeURIComponent(segments[i]);
        else if (patSegs[i] !== segments[i]) { match = false; break; }
      }
      if (!match) continue;
      try {
        await handler(req, res, { params, query: url.searchParams, url });
      } catch (err) {
        if (!res.headersSent) problem(res, 500, 'internal-error', String(err?.message ?? err));
      }
      return;
    }
    problem(res, 404, 'not-found', `${req.method} ${url.pathname}`);
  });
}

export function listen(server, port, host = '127.0.0.1') {
  return new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port)));
}

/** Close a server AND destroy its remaining connections — a bare server.close()
 * leaves keep-alive sockets holding the event loop open (hangs test processes). */
export function closeApp(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}
