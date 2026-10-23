// OpenNodes probe agent: a second measuring point for the registry's server-location checks.
// One job only: report the median TCP connect time from this machine to a public host on port 443.
// Bearer token required; private, loopback, link-local, CGNAT and multicast addresses refused;
// IPv4 only; globally rate-limited. No other ports, no payload, no response bodies relayed.
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';

const { PROBE_TOKEN, PROBE_SITE = 'unknown', PROBE_LAT, PROBE_LON } = process.env;
const PORT = Number(process.env.PORT ?? 8810);
if (!PROBE_TOKEN || PROBE_TOKEN.length < 24) throw new Error('PROBE_TOKEN (24+ chars) is required');

const PER_MINUTE = 60;
let windowStart = Date.now(), used = 0;
const allow = () => {
  if (Date.now() - windowStart > 60_000) { windowStart = Date.now(); used = 0; }
  return ++used <= PER_MINUTE;
};

function isPublicIPv4(ip) {
  if (net.isIP(ip) !== 4) return false;
  const [a, b] = ip.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;            // this-net, private, loopback, multicast/reserved
  if (a === 169 && b === 254) return false;                                  // link-local
  if (a === 172 && b >= 16 && b <= 31) return false;                         // private
  if (a === 192 && b === 168) return false;                                  // private
  if (a === 100 && b >= 64 && b <= 127) return false;                        // CGNAT
  return true;
}

function connectMs(ip, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const socket = net.connect({ host: ip, port: 443, timeout: timeoutMs });
    const done = (v) => { socket.destroy(); resolve(v); };
    socket.once('connect', () => done(performance.now() - t0));
    socket.once('timeout', () => done(null));
    socket.once('error', () => done(null));
  });
}

const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, site: PROBE_SITE });
  if (req.method !== 'POST' || req.url !== '/rtt') return send(res, 404, { error: 'not found' });
  if (req.headers.authorization !== `Bearer ${PROBE_TOKEN}`) return send(res, 401, { error: 'unauthorized' });
  if (!allow()) return send(res, 429, { error: 'rate limited' });
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 1024) return send(res, 413, { error: 'too large' }); }
  let host;
  try { host = String(JSON.parse(body).host ?? ''); } catch { return send(res, 400, { error: 'bad json' }); }
  if (!/^[a-z0-9.-]{1,253}$/i.test(host)) return send(res, 400, { error: 'bad host' });
  const ips = net.isIP(host) ? [host] : await dns.resolve4(host).catch(() => []);
  const ip = ips.find(isPublicIPv4);
  if (!ip) return send(res, 400, { error: 'no public IPv4 address' });
  const times = [];
  for (let i = 0; i < 3; i++) { const t = await connectMs(ip); if (t !== null) times.push(t); }
  times.sort((x, y) => x - y);
  const rtt = times.length ? Math.round(times[Math.floor(times.length / 2)] * 10) / 10 : null;
  send(res, 200, { site: PROBE_SITE, lat: Number(PROBE_LAT), lon: Number(PROBE_LON), ip, rtt_ms: rtt });
}).listen(PORT, '0.0.0.0', () => console.log(`probe agent ${PROBE_SITE} on :${PORT}`));
