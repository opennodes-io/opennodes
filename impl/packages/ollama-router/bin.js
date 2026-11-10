#!/usr/bin/env node
// onp-ollama: OpenNodes for Ollama — one Ollama-compatible endpoint across local, LAN, and verified public models.
import { startOllamaRouter } from './src/router.js';
import { DEFAULT_REPUTATION_PATH } from '@opennodes/cli/src/reputation.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const flags = (name) => args.flatMap((a, i) => a === `--${name}` ? [args[i + 1]] : []);
const has = (name) => args.includes(`--${name}`);

if (has('help') || args[0] === '-h') {
  console.log(`OpenNodes for Ollama — one endpoint for local, LAN, and verified public models.

  onp-ollama [--port 11435] [--ollama http://127.0.0.1:11434] [--peer <origin>]...
             [--registry <url>] [--min-tier community] [--max-request-usd 0.05] [--region eu]
             [--key host=token]... [--ledger receipts.jsonl] [--no-reputation] [--no-mdns] [--public-bind] [--sensitive]
             [--mask-pii off|open|all] [--pii-service <url>] [--pii-llm <model>[@<url>]]

Then point any Ollama app at it:   OLLAMA_HOST=127.0.0.1:11435
Models:  <your local models>  lan/<peer>/<model>  onp/<node>/<offering>
         auto  auto-cheap  auto-fast  auto-quality  auto-private (never leaves the LAN)  auto-sensitive (personal data: trusted pool only)  auto-eu  auto-ca  auto-<country> (LAN + operators in that jurisdiction)
Personal data: --sensitive (or ONP_SENSITIVE=1) for every request, header "onp-sensitive: 1" for one, or model auto-sensitive.
         The trusted pool: operators in ONP_TRUSTED_JURISDICTIONS (default EU,CA), declared model lineage without CN,
         tier verified or higher, no retention, no training on inputs. Your own and LAN models qualify only with a declared lineage.
PII masking: --mask-pii open (default, ONP_MASK_PII) replaces personal data with placeholders before an open-pool public model
         and puts it back in the answer; all: before every public model; off: never. Local and LAN models are never masked.
         Names and addresses need a local detector: --pii-service <url> (Presidio, ONP_PII_SERVICE) or --pii-llm <model>[@<url>] (ONP_PII_LLM).
         Masking does not make a request trusted: sensitive requests still use the trusted pool only.
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
    sensitive: has('sensitive') || ['1', 'true', 'yes'].includes(String(process.env.ONP_SENSITIVE ?? '').toLowerCase()),
  },
  keys,
  ledgerPath: flag('ledger', null),
  reputationPath: has('no-reputation') ? null : flag('reputation', DEFAULT_REPUTATION_PATH),
  mdns: !has('no-mdns'),
  maskPii: flag('mask-pii', null), piiService: flag('pii-service', null), piiLlm: flag('pii-llm', null),   // else ONP_MASK_PII, ONP_PII_SERVICE, ONP_PII_LLM
});

console.log(`OpenNodes for Ollama listening at ${router.origin}`);
console.log(`  local Ollama: ${flag('ollama', process.env.OLLAMA_UPSTREAM ?? 'http://127.0.0.1:11434')}   peers: ${router.peers.length}   registry: ${registry ?? '(none — LAN only)'}`);
console.log(`  set OLLAMA_HOST=${host === '0.0.0.0' ? '<this-host>' : '127.0.0.1'}:${router.port} in Open WebUI / Continue / Zed / any Ollama app`);
console.log(`  catalog: ${router.origin}/router/catalog   receipts: ${router.origin}/router/receipts   advice: ${router.origin}/router/advice`);
console.log(router.pii.mode === 'off' ? '  PII masking off (--mask-pii off)'
  : `  PII masking (${router.pii.detector}): placeholders before ${router.pii.mode === 'all' ? 'every public' : 'open-pool public'} models, values put back in the answer`);
