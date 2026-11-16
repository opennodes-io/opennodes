# OpenNodes plugin for Claude Code

Before you run bulk or repeatable AI work, see what it would cost across providers and pick where it runs.

```
/opennodes:quote summarise the 1,800 PDFs in ./contracts, EU only
```

You get one table: what you use now, a model on your own machine, checked hosted options, the cheapest option that can do the job, and an in-region option when a region matters. Each row shows where it runs, whether the registry has measured it, what it means for your data, and the estimated cost of the whole job. Nothing runs until you choose.

## Install

In a Claude Code terminal session:

```
/plugin marketplace add opennodes-io/opennodes
/plugin install opennodes@opennodes
```

In the Claude desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `opennodes-io/opennodes`, then add **opennodes**.

Needs Node.js 20 or later (the plugin starts `npx -y @opennodes/cli mcp`).

## What's in it

| Part | What it does |
|---|---|
| `opennodes` MCP server | The registry tools: `recommend`, `search_offerings`, `get_offering`, `get_node`, `estimate`, `find_locations`, `find_residency`. All read-only: nothing is invoked or charged. `recommend` analyses your task on your machine and sends only its features (kind, size, language), never the text. |
| `quote-before-run` skill | Claude uses it on its own when you're about to run model calls in bulk, or ask what something will cost or where it can run. |
| `/opennodes:quote` | The same, on request. With no argument it quotes what you're working on. |
| `offload-runner` agent | After you choose an option: runs the job through the local OpenNodes gateway, first as a pilot on a few items with sample results and measured cost, then the rest if you approve. It stops at your spend limit. |

## Data labels

Every option carries one of:

- **Stays on your machine**: a local Ollama model.
- **Stays in a region**: only when the provider publishes a residency commitment for it, with its level and who gets it.
- **Hosted, location known**: the countries the registry knows it serves from.
- **Hosted, location not published**: common for catalogue listings and routers. It means unknown, not unsafe.
- **Lower protection**: only with evidence: it serves from outside your legal area with no residency commitment for your region, or the provider states it may keep or train on prompts. Many of the cheapest options are here. For ordinary data that can be a fair trade; for personal or client data the plugin says it isn't suitable, and the offload agent won't send sensitive data to such an option unless you confirm that combination.

## Keys

Keys never go in the chat. The gateway reads them from environment variables (`OPENROUTER_API_KEY`, `HF_TOKEN`, `MISTRAL_API_KEY`, `GROQ_API_KEY`, `TOGETHER_API_KEY`, `DEEPINFRA_API_KEY`, `FIREWORKS_API_KEY`, `OPENAI_API_KEY`) and sends each only to its own host. Calls go from your machine straight to the provider; OpenNodes is never in the data path.

## Other clients

- **Cursor, VS Code**: the same MCP server, one click from https://opennodes.io/integrations.
- **Surge**: built in (Auto picks a node per prompt).

Licence: Apache-2.0.
