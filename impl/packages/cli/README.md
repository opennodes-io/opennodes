# @opennodes/cli

The OpenNodes Protocol (ONP) client: discover verified AI inference nodes, pre-price multi-step chains with enforceable estimates, invoke with pinned prices and signed receipts — and bring all of it into the tools you already use.

- **`onp mcp`** — a stdio MCP server for Cursor, VS Code, Claude Desktop and any MCP host. Tools: `recommend` (best node + model for a task, priced and explained; the prompt never leaves your machine — only extracted features are sent), `search_offerings`, `get_offering`, `get_node` (vet a provider: operator, tier history, availability), `estimate`.
- **`onp gateway`** — a local OpenAI-compatible server over discovered nodes. Point any OpenAI-SDK app at it. Virtual models `onp/auto`, `onp/auto-cheap`, `onp/auto-fast`, `onp/auto-quality`, `onp/auto-private`, `onp/auto-eu` (EU/EEA operators only), `onp/auto-ca` or any `onp/auto-<country>` route each request by the advisor; aliases and query-defined virtual models are supported; every call is receipted. **Failover:** auto models try up to 5 ranked nodes in turn; a node that hasn't started answering within a budget built from its measured latency and the request size (15 s – 3 min) is skipped; and an OpenRouter-style `models: ["a", "b"]` list in the request adds further models to try, in order (it is never forwarded to nodes). Auto-routing only picks what you can actually call: free registered nodes, plus the listings of any host you hold a key for — passed with `--key host=KEY` or picked up from `OPENROUTER_API_KEY`, `HF_TOKEN`, `OPENAI_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY`, `TOGETHER_API_KEY`, `DEEPINFRA_API_KEY`, `FIREWORKS_API_KEY` (each key is sent only to its own host; `--no-env-keys` turns detection off).
- **`onp search | estimate | invoke | card`** — the CLI.

```bash
npx @opennodes/cli mcp --print-config      # paste into your MCP host's config
npx @opennodes/cli gateway --port 4141     # then set OPENAI_BASE_URL=http://127.0.0.1:4141/v1
npx @opennodes/cli search --modality text --tier verified --sort tps
```

Registry: `ONP_REGISTRY` — defaults to the hosted registry at `https://registry.opennodes.io` (9,000+ offerings); set it to `http://127.0.0.1:4300` to use your own (`npx @opennodes/registry`).

Part of [OpenNodes](https://opennodes.io) · [specification](https://github.com/opennodes-io/opennodes/tree/main/spec) · Apache-2.0.
