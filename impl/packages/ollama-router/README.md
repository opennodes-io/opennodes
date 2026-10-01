# OpenNodes for Ollama

One Ollama-compatible endpoint for **your local models, your other machines, and verified public nodes** — so Open WebUI, Continue, Zed, JetBrains AI, Msty, Enchanted, Raycast, and anything else that speaks Ollama gains three tiers behind one model list, without changing a line.

```bash
npx @opennodes/ollama-router                       # LAN-only: local Ollama + discovered peers
ONP_REGISTRY=https://registry.opennodes.io npx @opennodes/ollama-router   # + verified public nodes
```

Then set `OLLAMA_HOST=127.0.0.1:11435` in your app.

| Tier | Models come from | Name | Cost |
|---|---|---|---|
| **local** | your own Ollama (`http://127.0.0.1:11434`) | `llama3.1:8b` | — |
| **lan** | other machines: plain Ollama servers or ONP Node Kit nodes, via `--peer` or mDNS | `lan/gpubox/llama3.1:70b` | — |
| **public** | the OpenNodes registry — verified providers, disclosed hardware, measured latency, pinned prices | `onp/org.example.lab/qwen3-235b` | signed receipt per call, budget cap |

Plus the advisor models, routed per request from the prompt's features (which never leave this machine):
`auto` · `auto-cheap` · `auto-fast` · `auto-quality` · **`auto-private`** (only local and LAN — nothing leaves your network).

What it does: Ollama native API (`/api/tags`, `/api/chat`, `/api/generate`, `/api/show`, `/api/ps`, embeddings and model management passed to local) with streaming translation for public nodes; OpenAI `/v1` alongside; a bare model name that isn't local falls through to a LAN copy; public calls are pinned to a card revision, receipted, verified (`amount = usage × pinned price`), and capped by `--max-request-usd`. Introspection: `/router/catalog`, `/router/advice`, `/router/receipts`.

Options: `--port`, `--ollama <url>`, `--peer <origin>` (repeatable), `--registry <url>`, `--min-tier community|verified`, `--max-request-usd 0.05`, `--region eu`, `--key host=token` (BYOK for imported catalogs), `--ledger file.jsonl`, `--no-mdns`, `--public-bind` (listen on all interfaces for other LAN machines).

**Publish your machine as a node** so the rest of your LAN (or the world) can discover it: `pipx install onp-node && onp-node init --engine http://127.0.0.1:11434/v1 --id org.example.mybox --public-url http://<lan-ip>:8800 && onp-node serve --mdns`.

Part of [OpenNodes](https://opennodes.io) · Apache-2.0.
