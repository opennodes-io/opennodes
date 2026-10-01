#!/usr/bin/env node
// onp-ollama: OpenNodes for Ollama — one Ollama-compatible endpoint across local, LAN, and verified public models.
import { startOllamaRouter } from './src/router.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const flags = (name) => args.flatMap((a, i) => a === `--${name}` ? [args[i + 1]] : []);
const has = (name) => args.includes(`--${name}`);

if (has('help') || args[0] === '-h') {
  console.log(`OpenNodes for Ollama — one endpoint for local, LAN, and verified public models.

  onp-ollama [--port 11435] [--ollama http://127.0.0.1:11434] [--peer <origin>]...
             [--registry <url>] [--min-tier community] [--max-request-usd 0.05] [--region eu]
             [--key host=token]... [--ledger receipts.jsonl] [--no-mdns] [--public-bind]

Then point any Ollama app at it:   OLLAMA_HOST=127.0.0.1:11435
Models:  <your local models>  lan/<peer>/<model>  onp/<node>/<offering>
         auto  auto-cheap  auto-fast  auto-quality  auto-private (never leaves the LAN)
Env:     ONP_REGISTRY (public tier; default https://registry.opennodes.io; --registry none for LAN-only), OLLAMA_UPSTREAM (local Ollama)
Publish this machine as a node:    pipx install onp-node && onp-node init --engine ${flag('ollama', process.env.OLLAMA_UPSTREAM ?? 'http://127.0.0.1:11434')}/v1 ...`);
  process.exit(0);
}

const keys = Object.fromEntries(flags('key').map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
const registryArg = flag('registry', process.env.ONP_REGISTRY ?? 'https://registry.opennodes.io');
const registry = registryArg === 'none' || registryArg === '' ? null : registryArg;
const host = has('public-bind') ? '0.0.0.0' : '127.0.0.1';

const router = await startOllamaRouter({
  port: Number(flag('port', 11435)),
  host,
  ollama: flag('ollama', process.env.OLLAMA_UPSTREAM ?? 'http://127.0.0.1:11434'),
  peers: flags('peer'),
  registry,
  policy: {
    min_tier: flag('min-tier', 'community'),
    max_request_usd: Number(flag('max-request-usd', 0.05)),
    ...(flag('region') ? { region: flag('region') } : {}),
  },
  keys,
  ledgerPath: flag('ledger', null),
  mdns: !has('no-mdns'),
});

console.log(`OpenNodes for Ollama listening at ${router.origin}`);
console.log(`  local Ollama: ${flag('ollama', process.env.OLLAMA_UPSTREAM ?? 'http://127.0.0.1:11434')}   peers: ${router.peers.length}   registry: ${registry ?? '(none — LAN only)'}`);
console.log(`  set OLLAMA_HOST=${host === '0.0.0.0' ? '<this-host>' : '127.0.0.1'}:${router.port} in Open WebUI / Continue / Zed / any Ollama app`);
console.log(`  catalog: ${router.origin}/router/catalog   receipts: ${router.origin}/router/receipts   advice: ${router.origin}/router/advice`);
