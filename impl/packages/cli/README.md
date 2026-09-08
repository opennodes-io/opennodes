# @opennodes/cli

The OpenNodes Protocol (ONP) client: discover verified AI inference nodes, pre-price multi-step chains with enforceable estimates, invoke with pinned prices and signed receipts — and bring all of it into the tools you already use.

- **`onp mcp`** — a stdio MCP server for Cursor, VS Code, Claude Desktop and any MCP host. Tools: `recommend` (best node + model for a task, priced and explained; the prompt never leaves your machine — only extracted features are sent), `search_offerings`, `get_offering`, `estimate`.
- **`onp gateway`** — a local OpenAI-compatible server over discovered nodes. Point any OpenAI-SDK app at it. Virtual models `onp/auto`, `onp/auto-cheap`, `onp/auto-fast`, `onp/auto-quality`, `onp/auto-private` route each request by the advisor; aliases and query-defined virtual models are supported; every call is receipted.
- **`onp search | estimate | invoke | card`** — the CLI.

```bash
npx @opennodes/cli mcp --print-config      # paste into your MCP host's config
npx @opennodes/cli gateway --port 4141     # then set OPENAI_BASE_URL=http://127.0.0.1:4141/v1
npx @opennodes/cli search --modality text --tier verified --sort tps
```

Registry: `ONP_REGISTRY` (default `http://127.0.0.1:4300` — run one locally with `npx @opennodes/registry`, or point at a hosted registry).

Part of [OpenNodes](https://opennodes.io) · [specification](https://github.com/opennodes-io/opennodes/tree/main/spec) · Apache-2.0.
