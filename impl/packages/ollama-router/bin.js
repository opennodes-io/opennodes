#!/usr/bin/env node
// onp-ollama: OpenNodes for Ollama — one Ollama-compatible endpoint across local, LAN, and verified public models.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { startOllamaRouter } from './src/router.js';
import { probePeer } from './src/discovery.js';
import { newToken } from './src/access.js';
import { DEFAULT_REPUTATION_PATH } from '@opennodes/cli/src/reputation.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const flags = (name) => args.flatMap((a, i) => a === `--${name}` ? [args[i + 1]] : []);
const has = (name) => args.includes(`--${name}`);
const list = (value) => String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const TOKEN_PATH = join(homedir(), '.opennodes', 'ollama-router-token');

if (has('help') || args[0] === '-h') {
  console.log(`OpenNodes for Ollama — one endpoint for local, LAN, and verified public models.

  onp-ollama [--port 11435] [--ollama http://127.0.0.1:11434] [--peer <origin>]... [--pin <key>]... [--mdns]
             [--registry <url>] [--min-tier community] [--max-request-usd 0.05] [--region eu]
             [--key host=token]... [--ledger receipts.jsonl] [--no-reputation] [--sensitive]
             [--token <token>] [--public-bind] [--allow-origin <origin>]... [--allow-host <name>]...
             [--mask-pii off|open|all] [--pii-service <url>] [--pii-llm <model>[@<url>]]
  onp-ollama --show-pin <origin>     print the card key of the ONP node at <origin> (run it on that machine)

Then point any Ollama app at it:   OLLAMA_HOST=127.0.0.1:11435
Models:  <your local models>  lan/<peer>/<model>  onp/<node>/<offering>
         auto  auto-cheap  auto-fast  auto-quality  auto-private (this machine and pinned LAN peers)  auto-sensitive (personal data: trusted pool only)  auto-eu  auto-ca  auto-<country> (pinned LAN peers + operators that declare that country)
LAN peers: --peer <origin> adds a machine (a plain Ollama server or a Node Kit node). It counts as your own network
         (auto-private, auto-<country>, sensitive requests) only when its card is signed by a key you pinned with --pin;
         get the key with --show-pin on that machine. --mdns finds Node Kit nodes on the LAN; a found node is used only
         when its card key is pinned. Plain Ollama servers have no key, so they are never pinned.
Access:  the router API (/router/*: peers, catalog, receipts, advice) needs "authorization: Bearer <token>". The token is
         --token or ONP_ROUTER_TOKEN, else one kept in ~/.opennodes/ollama-router-token. Apps on this machine use the model
         routes without it; browser pages only from localhost or an origin you allow with --allow-origin (ONP_ROUTER_ORIGINS).
         --public-bind listens on all interfaces and needs --token (or ONP_ROUTER_TOKEN): other machines must send it.
Jurisdiction: auto-eu and auto-<country> use the operator's DECLARED country (inferred by the registry for unclaimed imported
         listings). It is a declaration, not proof of where a request is processed: the registry's server check of the API's
         server front only drops a server it located outside, and a front that forwards requests elsewhere passes it.
Personal data: --sensitive (or ONP_SENSITIVE=1) for every request, header "onp-sensitive: 1" for one, or model auto-sensitive.
         The trusted pool: operators that declare a country in ONP_TRUSTED_JURISDICTIONS (default EU,CA) and whose server front
         passed the registry's location check (behind a CDN: every origin address the card declares), declared model lineage
         without CN, tier verified or higher, a declared data policy of no retention and no training on inputs.
         Your own and pinned LAN models qualify only with a declared lineage.
PII masking: --mask-pii open (default, ONP_MASK_PII) replaces personal data with placeholders before an open-pool public model
         and puts it back in the answer; all: before every public model; off: never. Local and LAN models are never masked.
         Names and addresses need a local detector: --pii-service <url> (Presidio, ONP_PII_SERVICE) or --pii-llm <model>[@<url>] (ONP_PII_LLM).
         Masking does not make a request trusted: sensitive requests still use the trusted pool only.
Env:     ONP_REGISTRY (public tier; default https://registry.opennodes.io; --registry none for LAN-only), OLLAMA_UPSTREAM (local Ollama)
Publish this machine as a node:    pipx install onp-node==0.1.9 && onp-node init --engine ${flag('ollama', process.env.OLLAMA_UPSTREAM ?? 'http://127.0.0.1:11434')}/v1 ...`);
  process.exit(0);
}

/** --show-pin <origin>: the card key to pin. Returns the exit code (no process.exit right after fetch: Node on Windows can abort). */
async function showPin(origin) {
  const peer = origin ? await probePeer(origin) : null;
  if (!peer || peer.kind !== 'onp') { console.error(`no ONP node card at ${origin ?? '(no origin given)'}`); return 1; }
  if (!peer.key) { console.error(`the card at ${peer.origin} (${peer.card.node?.id}) has no valid signature, so it cannot be pinned`); return 1; }
  console.log(`${peer.card.node?.id} at ${peer.origin}\n  card key: ${peer.key}\n  card endpoint: ${peer.card.endpoints?.openai}`
    + `\n  pin it on the router machine: onp-ollama --pin ${peer.key} --peer <the card endpoint's origin>   (or --mdns)`
    + `\n  a pin holds only where the node answers at its card endpoint's origin: set its --public-url to the LAN address the router uses`);
  return 0;
}

if (has('show-pin')) process.exitCode = await showPin(flag('show-pin'));
else await serve();

/** --token, ONP_ROUTER_TOKEN, else (loopback only) the token kept in ~/.opennodes/ollama-router-token. */
function routerToken(publicBind) {
  const given = String(flag('token', process.env.ONP_ROUTER_TOKEN ?? '')).trim();
  if (given || publicBind) return { token: given || null, where: 'as given' };   // --public-bind: chosen and handed out on purpose
  try {
    if (existsSync(TOKEN_PATH)) { const kept = readFileSync(TOKEN_PATH, 'utf8').trim(); if (kept) return { token: kept, where: `in ${TOKEN_PATH}` }; }
    mkdirSync(dirname(TOKEN_PATH), { recursive: true });
    const token = newToken();
    writeFileSync(TOKEN_PATH, token + '\n', { mode: 0o600 });
    return { token, where: `in ${TOKEN_PATH}` };
  } catch (err) {
    const token = newToken();
    console.error(`could not keep the router token in ${TOKEN_PATH} (${err.message}). For this run only it is: ${token}`);
    return { token, where: 'printed above, for this run only' };
  }
}

async function serve() {
  const keys = Object.fromEntries(flags('key').map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
  const registryArg = flag('registry', process.env.ONP_REGISTRY ?? 'https://registry.opennodes.io');
  const registry = registryArg === 'none' || registryArg === '' ? null : registryArg;
  const publicBind = has('public-bind');
  const host = publicBind ? '0.0.0.0' : '127.0.0.1';
  const { token, where: tokenWhere } = routerToken(publicBind);
  if (publicBind && !token) {
    console.error('--public-bind needs a token: other machines would reach the router, its peers and your provider keys unauthenticated.\n  Choose one and give it to your apps: onp-ollama --public-bind --token <token>   (or ONP_ROUTER_TOKEN)');
    process.exit(2);
  }

  let router;
  try {
    router = await startOllamaRouter({
      port: Number(flag('port', 11435)),
      host,
      ollama: flag('ollama', process.env.OLLAMA_UPSTREAM ?? 'http://127.0.0.1:11434'),
      peers: flags('peer'),
      pins: flags('pin'),
      token,
      allowOrigins: [...flags('allow-origin'), ...list(process.env.ONP_ROUTER_ORIGINS)],
      allowHosts: flags('allow-host'),
      registry,
      policy: {
        min_tier: flag('min-tier', 'community'),
        max_request_usd: Number(flag('max-request-usd', 0.05)),
        ...(flag('region') ? { region: flag('region') } : {}),
        sensitive: has('sensitive') || ['1', 'true', 'yes'].includes(String(process.env.ONP_SENSITIVE ?? '').toLowerCase()),
      },
      keys,
      ledgerPath: flag('ledger', null),
      reputationPath: has('no-reputation') ? null : flag('reputation', DEFAULT_REPUTATION_PATH),
      mdns: has('mdns'),   // off by default; --no-mdns is accepted and changes nothing
      maskPii: flag('mask-pii', null), piiService: flag('pii-service', null), piiLlm: flag('pii-llm', null),   // else ONP_MASK_PII, ONP_PII_SERVICE, ONP_PII_LLM
    });
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  console.log(`OpenNodes for Ollama listening at ${router.origin}`);
  console.log(`  local Ollama: ${flag('ollama', process.env.OLLAMA_UPSTREAM ?? 'http://127.0.0.1:11434')}   peers: ${router.peers.length} (${router.peers.filter((p) => p.pinned).length} pinned)   mDNS: ${has('mdns') ? 'on (found nodes are used only when pinned)' : 'off'}   registry: ${registry ?? '(none — LAN only)'}`);
  console.log(`  set OLLAMA_HOST=${host === '0.0.0.0' ? '<this-host>' : '127.0.0.1'}:${router.port} in Open WebUI / Continue / Zed / any Ollama app${publicBind ? ' (other machines: with "authorization: Bearer <token>")' : ''}`);
  console.log(`  router API (needs "authorization: Bearer <token>"; token ${tokenWhere}):`);
  console.log(`    ${router.origin}/router/catalog   ${router.origin}/router/receipts   ${router.origin}/router/advice`);
  console.log(router.pii.mode === 'off' ? '  PII masking off (--mask-pii off)'
    : `  PII masking (${router.pii.detector}): placeholders before ${router.pii.mode === 'all' ? 'every public' : 'open-pool public'} models, values put back in the answer`);
}
