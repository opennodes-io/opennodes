# OpenNodes Node Kit (Python) — MVP

Implements REQ-003 (subset): a reverse proxy that turns any **OpenAI-compatible engine**
(vLLM, TGI, Ollama — all expose `/v1`) into a conforming ONP Node without touching the engine.

Requires Python ≥3.11. Dependencies: `aiohttp`, `cryptography`.

## What it does

- **`onp-node init`** — interrogates the engine's `/v1/models`, writes `onp-node.toml`
  (operator fills in pricing / data policy / identity) and generates an Ed25519 signing key.
- **`onp-node serve`** — serves the signed Node Card at `/.well-known/open-node.json`, JWKS,
  the HTTP challenge endpoint, `/onp/health`, and proxies `/v1/models` + `/v1/chat/completions`
  with the ONP layer: header validation (409 `offering-mismatch` / `price_changed`), usage
  accounting (engine `usage` passed through; approximated when the engine omits it), and
  **signed receipts** — inline JWS header for non-streaming, by-URL (`/onp/receipts/{id}`,
  materialized after the stream ends) for streaming. Plain OpenAI traffic without ONP headers
  passes untouched (NK-INV-02) — existing engine users are unaffected.
- **`onp-node check`** — client-side Stage A self-test (card, signature, health,
  models agreement, blind invocation with usage + receipt); `register` refuses to submit
  while it fails (NK-REG-04, `--force` overrides).
- **`onp-node register <registry>`** — submits the card URL, stages the HTTP challenge token
  (the kit serves it itself), completes verification, prints the resulting tier + Stage A verdict.

## Cross-language proof

`tests/test_e2e.py` runs a mock engine → the kit → **the real JS registry as a subprocess**:
registration, challenge, card **signature verification across languages** (Python Ed25519
signer, JS verifier, byte-identical stable JSON), Stage A pass to `community`, search with
real pricing, pinned invoke with Python-verified receipt math, streaming receipt-by-URL,
both 409s, and untouched plain-OpenAI traffic.

```
python -m venv .venv
.venv\Scripts\python -m pip install aiohttp cryptography
.venv\Scripts\python -m unittest discover -s tests
```

## Real deployment (e.g. Ollama on this machine)

```
pipx install ./node-kit          # or: pip install -e .
onp-node init --engine http://127.0.0.1:11434/v1 --id org.example.mybox --public-url https://ai.example.org
# review onp-node.toml (pricing, data_policy), then:
onp-node serve
onp-node check
onp-node register https://registry.example.org
```

## MVP shortcuts (vs REQ-003)

- Prepaid API-key management (`onp-node keys`), free-tier rate limiting, probe-allowance
  accounting, Prometheus metrics, status UI: not yet built (NK-PAY-02/03, NK-INV-04, NK-REG-05).
- Engine adapters beyond the OpenAI-compatible surface (Ollama `/api/tags` fallback,
  TGI `/info` details, capability probing for tool_calls/vision) are minimal: models come
  from `/v1/models` only, `supports` defaults to `["streaming"]`.
- Card revision changes require a serve restart; no `apply`/ping-on-revision yet (NK-REG-02).
- TLS termination is assumed to happen in front (reverse proxy/ingress).
