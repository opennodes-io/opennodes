# OpenNodes for Ollama

One Ollama-compatible endpoint for **your local models, your other machines, and verified public nodes** — so Open WebUI, Continue, Zed, JetBrains AI, Msty, Enchanted, Raycast, and anything else that speaks Ollama gains three tiers behind one model list, without changing a line.

```bash
npx @opennodes/ollama-router@0.1.28           # local Ollama + the LAN peers you add + public nodes from registry.opennodes.io
npx @opennodes/ollama-router@0.1.28 --registry none  # LAN-only: nothing leaves your network
```

Then set `OLLAMA_HOST=127.0.0.1:11435` in your app.

| Tier | Models come from | Name | Cost |
|---|---|---|---|
| **local** | your own Ollama (`http://127.0.0.1:11434`) | `llama3.1:8b` | — |
| **lan** | other machines: plain Ollama servers or ONP Node Kit nodes you add with `--peer`, or Node Kit nodes found by mDNS (`--mdns`) whose card key you pinned | `lan/gpubox/llama3.1:70b` | — |
| **public** | the OpenNodes registry — verified providers, disclosed hardware, measured latency, pinned prices | `onp/org.example.lab/qwen3-235b` | signed receipt per call, budget cap |

Plus the advisor models, routed per request from the prompt's features (which never leave this machine):
`auto` · `auto-cheap` · `auto-fast` · `auto-quality` · **`auto-private`** (only this machine and LAN peers pinned by card key — nothing leaves your network; simple requests stay on this machine, demanding ones — code, reasoning, long documents, tool use — go to your strongest pinned LAN machine) · **`auto-eu`** (this machine, pinned LAN peers, and public operators in the EU/EEA) · **`auto-ca`** or any **`auto-<country>`** (the same for that country, e.g. Canada) · **`auto-sensitive`** (for personal data: the trusted pool only).

**Personal data (ONP-3 §5e).**
- **What qualifies:** the trusted pool is models with a declared lineage that excludes CN. Public offerings must also be verified or higher, run by operators in `ONP_TRUSTED_JURISDICTIONS` (default `EU,CA`), and declare no retention and no training on inputs.
- **How to mark requests:** `--sensitive` (or `ONP_SENSITIVE=1`) marks every request, the header `onp-sensitive: 1` marks one, and `auto-sensitive` routes for it.
- **What happens:** a marked request is never sent outside the pool. A named model outside it gets 403 with the reason (e.g. `model lineage not declared`). `auto-sensitive` with nothing trusted gets 404. Local and LAN Ollama models declare no lineage, so today they do not qualify. A LAN peer qualifies only when it is pinned and its card declares a lineage. `/router/catalog` shows each model's pool.

**LAN peers: added, pinned, found (ONP-3 §5b).**
- **Added:** `--peer <origin>` (or `POST /router/peers {"origin": "…"}` with the router token) adds a machine: a plain Ollama server or a Node Kit node. You can use its models by name (`lan/gpubox/llama3.1:70b`, or a bare name you have no local copy of) and through `auto`, `auto-cheap`, `auto-fast` and `auto-quality`. The router knows nothing of its operator, location or data policy, so it ranks as unverified and is **not** used for `auto-private`, `auto-<country>` or sensitive requests.
- **Pinned:** `--pin <key>` (repeatable) names a key, by its RFC 7638 thumbprint, that signs a Node Kit node's card. A peer is your own network when its card is signed by a pinned key and it answers at the address that card names (the node's `--public-url`, so set that to its LAN address). A copy of a pinned card served from another address is not pinned. A pinned peer serves `auto-private`, `auto-<country>` and, with a declared lineage, the trusted pool. The router checks the signature again whenever it reloads the card (every 30 s while in use), and a card signed by another key loses the pin at once. Get the key on the node's own machine: `npx @opennodes/ollama-router@0.1.28 --show-pin http://127.0.0.1:8800`. A plain Ollama server has no card or key, so it cannot be pinned. To pin one, put a Node Kit node in front of it (`onp-node init --engine http://127.0.0.1:11434/v1`).
- **Found:** mDNS discovery is off unless you pass `--mdns`. A Node Kit node found that way is used only when it is pinned. Otherwise it is listed under `discovered` in `/router/catalog`, with its key and the endpoint its card names. An advertised `origin` that is not the advertising host is ignored.
- A LAN card without a data policy is unknown, never "no retention". The router calls a LAN node at the address it reached, not at an address its card names. LAN models are never PII-masked.

**Access.** The router never sends `Access-Control-Allow-Origin: *`.
- The router API (`/router/*`) always needs `authorization: Bearer <token>`. The token is `--token` or `ONP_ROUTER_TOKEN`, else one the router creates and keeps in `~/.opennodes/ollama-router-token`.
- Apps on this machine use the Ollama and OpenAI routes without the token. The Host must be a local name: `127.0.0.1`, `localhost`, `[::1]`, `host.docker.internal`, this machine's name, or one you add with `--allow-host`. A browser request is accepted only from a page on localhost or from an origin you allow with `--allow-origin` (repeatable, or `ONP_ROUTER_ORIGINS`; `*` is refused).
- `--public-bind` listens on all interfaces and requires `--token` (or `ONP_ROUTER_TOKEN`). Every request from another machine must send it.

What it does: Ollama native API (`/api/tags`, `/api/chat`, `/api/generate`, `/api/show`, `/api/ps`, embeddings and model management passed to local) with streaming translation for public nodes; OpenAI `/v1` alongside; a bare model name that isn't local falls through to a LAN copy; public calls are pinned to a card revision, receipted, verified (`amount = usage × pinned price`), and capped by `--max-request-usd`. Failover: candidates are tried in order; an ONP node that hasn't started answering within a budget from its measured latency and the request size is skipped (local Ollama gets its usual long timeout), and on `/v1/chat/completions` an OpenRouter-style `models: [...]` list adds further models to try. **Passive reputation:** every call is remembered per offering — outcome and timing only, never prompts or answers — in `~/.opennodes/reputation.json` (last 50 calls, 30 days; `--no-reputation` to keep it in memory). With 3+ calls it fills success rate and time to first token where the registry has measured nothing (imported listings), and an offering with 3 failures in a row is benched for 15 minutes; registry measurements from blind probes always win. Advice says "your calls: 19 of 20 ok, first token 820 ms". Introspection, with the router token: `/router/catalog`, `/router/advice`, `/router/receipts`, `/router/reputation`.

Options: `--port`, `--ollama <url>`, `--peer <origin>` (repeatable), `--pin <key>` (repeatable), `--mdns`, `--registry <url>`, `--min-tier community|verified`, `--max-request-usd 0.05`, `--region eu`, `--key host=token` (BYOK for imported catalogs), `--ledger file.jsonl`, `--no-reputation`, `--token <token>`, `--public-bind` (listen on all interfaces for other LAN machines; needs `--token`), `--allow-origin <origin>` (repeatable), `--allow-host <name>` (repeatable), `--sensitive`, `--show-pin <origin>`.

**Publish your machine as a node** so the rest of your LAN (or the world) can discover it: `pipx install onp-node==0.1.9 && onp-node init --engine http://127.0.0.1:11434/v1 --id org.example.mybox --public-url http://<lan-ip>:8800 && onp-node serve --mdns`. On that machine, `npx @opennodes/ollama-router@0.1.28 --show-pin http://127.0.0.1:8800` prints its card key. Pin it on the router machine with `--pin <key>`, plus `--mdns` or `--peer http://<lan-ip>:8800`.

Part of [OpenNodes](https://opennodes.io) · Apache-2.0.
