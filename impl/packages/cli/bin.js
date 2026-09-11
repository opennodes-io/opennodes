#!/usr/bin/env node
// onp CLI (REQ-002 subset): search | estimate | invoke | card | health
import { OnpClient } from './src/client.js';
import { startGateway } from './src/gateway.js';
import { createStdioMcp } from './src/mcpserver.js';

const [cmd, ...args] = process.argv.slice(2);
const registry = process.env.ONP_REGISTRY ?? 'http://127.0.0.1:4300';
const client = new OnpClient({ registry });

const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

try {
  switch (cmd) {
    case 'search': {
      const params = {};
      for (const key of ['modality', 'family', 'min_context', 'supports', 'max_input_price', 'scheme', 'tier', 'lang', 'q', 'sort']) {
        const v = flag(key);
        if (v !== undefined) params[key] = v;
      }
      const offerings = await client.search(params);
      for (const o of offerings) {
        console.log(`${o.node_id}/${o.offering_id}  [${o.tier}]  ${o.model.name}  ` +
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
      const { completion, receipt } = await client.invoke(offering, [{ role: 'user', content: prompt }]);
      console.log(completion.choices[0].message.content);
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
        const server = installed
          ? { command: 'npx', args: ['-y', '@opennodes/cli', 'mcp'], env: { ONP_REGISTRY: registry } }
          : { command: process.execPath, args: [binPath, 'mcp'], env: { ONP_REGISTRY: registry } };
        console.log('Add to Cursor (~/.cursor/mcp.json), VS Code (mcp.json), or Claude Desktop config:');
        console.log(JSON.stringify({ mcpServers: { opennodes: server } }, null, 2));
        break;
      }
      // Stdio MCP server for editor hosts. stdout carries protocol messages only.
      createStdioMcp({ registry });
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
      const gw = await startGateway({
        registry,
        port: Number(flag('port', 4141)),
        token: flag('token', null),
        aliases,
        virtuals,
        keys,
        ledgerPath: flag('ledger', null),
      });
      console.log(`onp gateway (OpenAI-compatible) at ${gw.origin}/v1`);
      console.log(`point Cursor / VS Code / Open WebUI base URL here`);
      if (Object.keys(aliases).length) console.log('aliases:', aliases);
      if (Object.keys(virtuals).length) console.log('virtual models:', virtuals);
      await new Promise(() => {}); // run until Ctrl+C
      break;
    }
    case 'health': {
      console.log(JSON.stringify(await (await fetch(`${registry}/v0/health`)).json(), null, 2));
      break;
    }
    default:
      console.log(`onp — OpenNodes client (MVP)
usage:
  onp search [--modality text] [--tier community] [--lang en:strong] [--sort price|rank] ...
  onp estimate --offering <node_id>/<offering_id> [--in 1000] [--out 500]
  onp invoke --offering <node_id>/<offering_id> [--prompt "..."]
  onp card <node-origin-url>
  onp gateway [--port 4141] [--token secret] [--alias fast=node.id/offering] [--virtual auto-cheap=modality=text&sort=price] [--key openrouter.ai=sk-or-...] [--ledger receipts.jsonl]
  onp mcp [--print-config]    # stdio MCP server for Cursor / VS Code / Claude Desktop
  onp health
env: ONP_REGISTRY (default http://127.0.0.1:4300)`);
  }
} catch (err) {
  console.error('error:', err.message);
  process.exit(1);
}
