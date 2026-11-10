#!/usr/bin/env node
// onp CLI (REQ-002 subset): search | estimate | invoke | card | health
import { OnpClient } from './src/client.js';
import { startGateway, TIERS, credentialsFrom } from './src/gateway.js';
import { checkOffering, saveCheck, DEFAULT_CHECKS_PATH } from './src/check.js';
import { DEFAULT_REPUTATION_PATH } from './src/reputation.js';
import { createStdioMcp } from './src/mcpserver.js';
import { piiDetectorFrom, describeMaskCounts } from '@opennodes/core';

const [cmd, ...args] = process.argv.slice(2);
// Default: the hosted OpenNodes registry. Point ONP_REGISTRY at http://127.0.0.1:4300 for a local one.
const registry = process.env.ONP_REGISTRY ?? 'https://registry.opennodes.io';
// Personal data: --sensitive or ONP_SENSITIVE=1 keeps every request in the trusted pool
// (operators in ONP_TRUSTED_JURISDICTIONS, default EU,CA; see ONP-3 §5e).
const sensitive = args.includes('--sensitive') || ['1', 'true', 'yes'].includes(String(process.env.ONP_SENSITIVE ?? '').toLowerCase());
const client = new OnpClient({ registry, policy: { sensitive } });

const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
// PII masking before the open pool (docs/pii-masking.md): --mask-pii off|open|all (ONP_MASK_PII, default open);
// detectors besides the rules, on this machine or network: --pii-service <url> (ONP_PII_SERVICE), --pii-llm <model>[@<url>] (ONP_PII_LLM).
const pii = {
  maskPii: flag('mask-pii') ?? process.env.ONP_MASK_PII ?? null,
  piiService: flag('pii-service') ?? process.env.ONP_PII_SERVICE ?? null,
  piiLlm: flag('pii-llm') ?? process.env.ONP_PII_LLM ?? null,
};
client.policy.mask_pii = pii.maskPii;   // read by invoke(); an unknown mode is an error there

try {
  switch (cmd) {
    case 'search': {
      const params = {};
      for (const key of ['modality', 'family', 'min_context', 'supports', 'max_input_price', 'scheme', 'tier', 'lang', 'q', 'sort',
        'jurisdiction', 'region', 'exclude_lineage', 'lineage', 'retention', 'no_training', 'trust']) {
        const v = flag(key);
        if (v !== undefined) params[key] = v;
      }
      if (sensitive) params.trust = 'trusted';
      let offerings = await client.search(params);
      if (sensitive) offerings = offerings.filter((o) => !client.trustGapsOf(o).length);   // an older registry ignores trust
      for (const o of offerings) {
        console.log(`${o.node_id}/${o.offering_id}  [${o.tier}${o.pool ? `, ${o.pool}` : ''}]  ${o.model.name}  ` +
          `$${o.pricing.input_per_mtok}/$${o.pricing.output_per_mtok} per MTok  rank=${o.rank}`);
      }
      if (!offerings.length) console.log('(no offerings match)');
      break;
    }
    case 'estimate': {
      const offering = flag('offering');
      const result = await client.estimate([{
        offering,
        est_input_tokens: Number(flag('in', 1000)),
        est_output_tokens: Number(flag('out', 500)),
      }]);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'invoke': {
      const [nodeId, offeringId] = flag('offering', '').split('/');
      const prompt = flag('prompt', 'Hello from OpenNodes.');
      const offerings = await client.search({});
      const offering = offerings.find((o) => o.node_id === nodeId && o.offering_id === offeringId);
      if (!offering) throw new Error(`offering not found in registry: ${flag('offering')}`);
      client.piiDetector = piiDetectorFrom({ service: pii.piiService, llm: pii.piiLlm, env: {} });
      const { completion, receipt, pii_masked } = await client.invoke(offering, [{ role: 'user', content: prompt }]);
      console.log(completion.choices[0].message.content);
      if (pii_masked) console.log(`pii masked before sending: ${describeMaskCounts(pii_masked) || 'nothing found'}`);
      if (receipt) console.log(`receipt: ${receipt.receipt_id}  ${receipt.amount.currency} ${receipt.amount.value}  usage ${receipt.usage.prompt_tokens}+${receipt.usage.completion_tokens}`);
      break;
    }
    case 'card': {
      const { card } = await client.resolveCard(args[0]);
      console.log(JSON.stringify(card, null, 2));
      break;
    }
    case 'mcp': {
      if (args.includes('--print-config')) {
        const binPath = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
        // Installed from npm → portable npx form; running from a checkout → absolute path.
        const installed = /[\\/]node_modules[\\/]@opennodes[\\/]cli[\\/]/.test(binPath);
        const env = { ONP_REGISTRY: registry, ...(sensitive ? { ONP_SENSITIVE: '1' } : {}),
          ...(process.env.ONP_TRUSTED_JURISDICTIONS ? { ONP_TRUSTED_JURISDICTIONS: process.env.ONP_TRUSTED_JURISDICTIONS } : {}) };
        const server = installed
          ? { command: 'npx', args: ['-y', '@opennodes/cli', 'mcp'], env }
          : { command: process.execPath, args: [binPath, 'mcp'], env };
        console.log('Add to Cursor (~/.cursor/mcp.json), VS Code (mcp.json), or Claude Desktop config:');
        console.log(JSON.stringify({ mcpServers: { opennodes: server } }, null, 2));
        break;
      }
      // Stdio MCP server for editor hosts. stdout carries protocol messages only.
      createStdioMcp({ registry, sensitive });
      await new Promise(() => {}); // run until the host closes stdin / kills us
      break;
    }
    case 'gateway': {
      const aliases = {};
      const virtuals = {};
      const keys = {};
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--alias') {
          const [name, target] = args[++i].split('=');
          aliases[name] = target;
        } else if (args[i] === '--virtual') {
          const eq = args[++i].indexOf('=');
          virtuals[args[i].slice(0, eq)] = args[i].slice(eq + 1);
        } else if (args[i] === '--key') {
          const eq = args[++i].indexOf('=');
          keys[args[i].slice(0, eq)] = args[i].slice(eq + 1);
        }
      }
      const minTier = flag('min-tier');
      if (minTier && !TIERS.includes(minTier)) throw new Error(`--min-tier must be one of ${TIERS.join(', ')}`);
      const gw = await startGateway({
        registry,
        port: Number(flag('port', 4141)),
        token: flag('token', null),
        aliases,
        virtuals,
        keys,
        policy: { ...(minTier ? { min_tier: minTier } : {}), sensitive },
        reputationPath: args.includes('--no-reputation') ? null : flag('reputation', DEFAULT_REPUTATION_PATH),
        // embeddings go to the local Ollama's embedding models first (not OLLAMA_HOST: that may be the router)
        ollama: args.includes('--no-ollama') ? null : flag('ollama', 'http://127.0.0.1:11434'),
        ledgerPath: flag('ledger', null),
        env: args.includes('--no-env-keys') ? {} : process.env,
        ...pii,
      });
      console.log(`onp gateway (OpenAI-compatible) at ${gw.origin}/v1`);
      console.log(gw.keyHosts.length
        ? `keys for: ${gw.keyHosts.join(', ')} (each sent only to its own host)`
        : 'no provider keys: onp/auto uses free registered nodes only (add --key host=KEY or set OPENROUTER_API_KEY / HF_TOKEN)');
      console.log(`point Cursor / VS Code / Open WebUI base URL here`);
      console.log(sensitive
        ? `sensitive: every request stays in the trusted pool (${gw.trusted.jurisdictions} operators, declared lineage without CN, verified+, no retention, no training)`
        : 'sensitive requests: send header "onp-sensitive: 1" or use model onp/auto-sensitive (trusted pool only); --sensitive marks every request');
      console.log({
        open: `PII masking (${gw.pii.detector}): personal data is replaced by placeholders before an open-pool offering, and put back in the answer`,
        all: `PII masking (${gw.pii.detector}): personal data is replaced by placeholders before every hosted offering, and put back in the answer`,
        off: 'PII masking off (--mask-pii off): requests are sent as they are',
      }[gw.pii.mode]);
      if (Object.keys(aliases).length) console.log('aliases:', aliases);
      if (Object.keys(virtuals).length) console.log('virtual models:', virtuals);
      await new Promise(() => {}); // run until Ctrl+C
      break;
    }
    case 'check': {
      // Your own quick verification of an offering, with your key and a spend cap (default $0.02).
      const target = args[0] && !args[0].startsWith('--') ? args[0] : null;
      let offering;
      if (flag('url')) {
        offering = { endpoints: { openai: flag('url') }, binding: { model_id: flag('model') }, pricing: {}, serving: {} };
        if (!flag('model')) throw new Error('--url needs --model <model id>');
      } else {
        if (!target) throw new Error('usage: onp check <node_id>/<offering_id>  or  onp check --url <base>/v1 --model <id>');
        const [nodeId, offeringId] = target.split('/');
        const res = await fetch(`${registry}/v0/offerings/${encodeURIComponent(nodeId)}/${encodeURIComponent(offeringId)}`);
        if (!res.ok) throw new Error(`offering not found in registry: ${target}`);
        offering = await res.json();
      }
      const keys = {};
      for (let i = 0; i < args.length; i++) if (args[i] === '--key') { const eq = args[++i].indexOf('='); keys[args[i].slice(0, eq)] = args[i].slice(eq + 1); }
      const host = new URL(offering.endpoints.openai).hostname;
      const key = credentialsFrom(keys, args.includes('--no-env-keys') ? {} : process.env)[host] ?? null;
      const maxUsd = Number(flag('max-usd', 0.02));
      const context = flag('context', '8192');
      const marks = { pass: '✓', warn: '!', fail: '✗', skip: '–' };
      if (!args.includes('--json')) console.log(`checking ${offering.node_id ? `${offering.node_id}/${offering.offering_id}` : offering.binding.model_id} at ${offering.endpoints.openai}${key ? '' : ' (no key)'} · spend cap $${maxUsd}`);
      const result = await checkOffering(offering, {
        key, maxUsd, contextTokens: context === 'full' ? 'full' : Number(context),
        log: args.includes('--json') ? () => {} : (name, status, detail) => console.log(`  ${marks[status]} ${name.padEnd(15)} ${detail}`),
      });
      if (!args.includes('--no-save')) saveCheck(result, flag('checks', DEFAULT_CHECKS_PATH));
      if (args.includes('--json')) { console.log(JSON.stringify(result, null, 2)); break; }
      console.log(`${result.ok ? 'passed' : result.usable ? `usable, with issues: ${result.failed.join(', ')}` : 'not usable'} · spent ≈ $${result.spent_usd} (${result.price_basis})`);
      if (!args.includes('--no-save')) console.log(`saved for the gateway: onp/auto ${result.usable ? 'uses your measurements for it' : 'will skip it'} for 7 days`);
      if (!result.usable) process.exitCode = 2;
      break;
    }
    case 'health': {
      console.log(JSON.stringify(await (await fetch(`${registry}/v0/health`)).json(), null, 2));
      break;
    }
    default:
      console.log(`onp — OpenNodes client (MVP)
usage:
  onp search [--modality text] [--tier community] [--lang en:strong] [--sort price|rank] [--trust trusted] [--retention none] [--no_training true] [--lineage declared] ...
  onp estimate --offering <node_id>/<offering_id> [--in 1000] [--out 500]
  onp invoke --offering <node_id>/<offering_id> [--prompt "..."] [--sensitive] [--mask-pii off|open|all] [--pii-service <url>] [--pii-llm <model>[@<url>]]
  onp card <node-origin-url>
  onp gateway [--port 4141] [--token secret] [--alias fast=node.id/offering] [--virtual auto-cheap=modality=text&sort=price] [--key openrouter.ai=sk-or-...] [--no-env-keys] [--min-tier unverified|community|verified] [--no-reputation] [--ollama http://127.0.0.1:11434 | --no-ollama] [--ledger receipts.jsonl] [--mask-pii off|open|all] [--pii-service <url>] [--pii-llm <model>[@<url>]]
  onp check <node_id>/<offering_id> [--key host=KEY] [--max-usd 0.02] [--context 8192|full] [--json] [--no-save]
  onp check --url https://api.example.com/v1 --model <id>    # any OpenAI-compatible endpoint
  onp mcp [--print-config] [--sensitive]    # stdio MCP server for Cursor / VS Code / Claude Desktop
  onp health
--sensitive (or ONP_SENSITIVE=1): the requests carry personal data, so only the trusted pool is used
--mask-pii (or ONP_MASK_PII): open (default) masks personal data before open-pool offerings and puts it back in the answer;
     all: before every hosted offering; off: never. Add a local Presidio service (--pii-service, ONP_PII_SERVICE)
     or a local model (--pii-llm, ONP_PII_LLM) to find names and addresses. Masking does not make a request trusted.
env: ONP_REGISTRY (default https://registry.opennodes.io; a local registry runs at http://127.0.0.1:4300),
     ONP_TRUSTED_JURISDICTIONS (operators of the trusted pool; default EU,CA)`);
  }
} catch (err) {
  console.error('error:', err.message);
  process.exit(1);
}
