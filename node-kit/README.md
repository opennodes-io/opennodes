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
pipx install onp-node            # from PyPI; from a checkout: pipx install ./node-kit
onp-node init --engine http://127.0.0.1:11434/v1 --id org.example.ai --public-url https://ai.example.org
# The node id must be the reverse of the host that serves it (ai.example.org -> org.example.ai, or a
# name below it such as org.example.ai.box): registries accept a card only from a host that controls the id.
# review onp-node.toml (pricing, data_policy), then:
onp-node serve                   # add --mdns (pip install 'onp-node[mdns]') so LAN clients such as onp-ollama discover it
onp-node check
onp-node register https://registry.example.org
```

## Card-only listing (you already run an OpenAI-compatible API)

If you operate a production API and won't put a proxy in its path, list it with a static card instead. The kit signs the card once; you host two JSON files on your domain; the registry probes your real API with a key you provide.

```
pipx install onp-node
onp-node init --engine https://api.example.com/v1 --id com.example.ai --public-url https://ai.example.com   # ONP_ENGINE_KEY=<key> if /models needs one
# edit onp-node.toml: pricing (per MTok), schemes = ["prepaid"], data_policy, optional [hardware]
onp-node card --signup https://console.example.com/keys --out well-known
# host well-known/open-node.json and well-known/jwks.json at https://ai.example.com/.well-known/
ONP_PROBE_KEY=<a key with a small quota> onp-node register https://registry.opennodes.io \
    --card-url https://ai.example.com/.well-known/open-node.json --probe-key-env ONP_PROBE_KEY
# it prints a challenge: publish it as /.well-known/onp-challenge/<token> or a DNS TXT record; the command waits
```

- The node id is the reverse of the host serving the card (`ai.example.com` → `com.example.ai`); your API may live on any host.
- The probe key is held as pending until your challenge passes, is sent only to your card's own endpoints, and never appears in any registry API. Give it a small dedicated quota.
- `health` defaults to your `/models` endpoint. Card-only listings carry no ONP receipts and no revision enforcement — clients call your API exactly as they do today.
- Once you're verified, imported catalog listings that point at your own API (for example from models.dev) are retired automatically, so your verified listing replaces them rather than appearing beside them. Listings that reach your models through Hugging Face's or OpenRouter's routers stay: those are their routes, not yours.

## MVP shortcuts (vs REQ-003)

- Prepaid API-key management (`onp-node keys`), free-tier rate limiting, probe-allowance
  accounting, Prometheus metrics, status UI: not yet built (NK-PAY-02/03, NK-INV-04, NK-REG-05).
- Engine adapters beyond the OpenAI-compatible surface (Ollama `/api/tags` fallback,
  TGI `/info` details, capability probing for tool_calls/vision) are minimal: models come
  from `/v1/models` only, `supports` defaults to `["streaming"]`.
- Card revision changes require a serve restart; no `apply`/ping-on-revision yet (NK-REG-02).
- TLS termination is assumed to happen in front (reverse proxy/ingress).
