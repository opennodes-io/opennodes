# PII masking before the open pool

Status 2026-11-10: in `@opennodes/core` (`impl/packages/core/src/pii.js`) and on by default in the three
reference clients: the gateway (`onp gateway`), `onp invoke` (`OnpClient.invoke`) and the Ollama router
(`onp-ollama`). Tests: `impl/test/pii.test.js` (the module) and `impl/test/pii-wiring.test.js` (the clients,
end to end against a registry and a node).

## Why

Operators are in two pools (ONP-3 §5e). The trusted pool (EU/EEA and Canada, declared lineage without CN,
verified, no retention, no training) may receive personal data. The open pool is for tasks without
personal data. Masking lets more traffic use the open pool safely: before a request goes to an open-pool
operator, the client replaces the personal data it finds with placeholders, and puts the values back in
the answer on the user's machine.

Masking does **not** make a request trusted. A request marked sensitive (`--sensitive`, `ONP_SENSITIVE=1`,
`onp-sensitive: 1`, `auto-sensitive`) still goes to the trusted pool only, and is refused when nothing
there qualifies. A client that must stay in the trusted cluster, such as CanadaLink, runs with
`--sensitive`.

## How it works

Adapted from WebTester's masking (`WebTester.Core/Privacy`, see its `docs/PII_MASKING.md`):

```
request ──> detectors (on this machine) ──> spans ──> masker ──> "Mail [[EMAIL_1]]" ──> open-pool operator
answer  <── values put back (vault, in memory, this request only) <── "Sent to [[EMAIL_1]]" <──┘
```

- **Detectors** only point at personal data; one masker replaces it, so all detectors mask the same way.
  - `regex` (always on): e-mail, phone (North American and international `+…`), card (Luhn-checked),
    IBAN (mod-97-checked), US SSN, Canadian SIN, Canadian postal code, public IPv4, and dates of birth
    and identifiers named by a label (`DOB: …`, `passport no. …`, `health card …`, `account …`).
  - `presidio`: WebTester's local service (`WebTester/tools/pii/pii_service.py`, Microsoft Presidio with
    Canadian recognizers, or LLM Guard). `ONP_PII_SERVICE=http://127.0.0.1:5123`.
  - `llm`: a local model, OpenAI-compatible (Ollama, vLLM). `ONP_PII_LLM=gemma3:12b` or
    `ONP_PII_LLM=google/gemma-4-31B-it@http://192.168.1.20:8000/v1`.
  - Configured detectors run together; whatever any finds is masked. A detector reads raw text, so a URL
    that is not on this machine or the private network is refused.
- **Placeholders** look like `[[PERSON_1]]`. The same value gets the same placeholder throughout the
  request, so the conversation stays coherent. Placeholders already in the text are kept and never reused.
- **What is masked in a chat request:** the text of every message (system, user, assistant, tool), text
  content parts, the arguments of earlier tool calls (kept valid JSON), and a legacy `prompt`. Tool
  definitions and settings are not. Embeddings: string inputs.
- **Reversible:** the answer's text, reasoning and tool-call arguments get the values back, also when
  streamed (a placeholder split over two chunks is held back until it is whole). The vault exists only in
  memory for one request; it is never logged or sent. Logs may carry counts by type (`EMAIL=1,PERSON=2`).
- **Receipts:** the request hash in an ONP receipt covers the bytes actually sent, which are the masked
  ones, so receipt checks are unchanged and the receipt shows what left.

## In the clients

The same settings in `onp gateway`, `onp invoke` and `onp-ollama`:

| Setting | Effect |
|---|---|
| `--mask-pii open` (default), `ONP_MASK_PII` | Requests to open-pool offerings are masked |
| `--mask-pii all` | Every hosted offering is masked, trusted ones too |
| `--mask-pii off` | No masking |
| header `onp-mask-pii: open\|all` | One request asks for more masking; it cannot ask for less (`off` in the header is ignored) |
| `--pii-service <url>` (`ONP_PII_SERVICE`), `--pii-llm <model>[@<url>]` (`ONP_PII_LLM`) | Add Presidio / a local model to the rules |

Library use: `startGateway({ maskPii, piiService, piiLlm, piiDetector })`, `startOllamaRouter({ … the same })`,
`new OnpClient({ policy: { mask_pii }, piiDetector })`.

- What is masked: gateway chat completions and embeddings; `onp invoke`; the router's `/api/chat`,
  `/api/generate` and `/v1/chat/completions` to public offerings. Answers, streamed or whole, get the
  values back (in the router's Ollama routes too, after translation).
- Models on the user's own machine or LAN (the gateway's local Ollama embedders, the router's local and LAN
  models) are never masked: their data reaches no operator.
- Fail closed: if a detector fails, the request is not sent to that offering (a `policy` refusal, HTTP 403
  when every candidate is refused); the next candidate is tried, and a trusted or local one needs no masking.
- Images, audio, files and token-array inputs cannot be masked: with masking on they are not sent to an
  open-pool offering (403, "… content cannot be masked").
- An unknown mode (`--mask-pii sometimes`, `onp-mask-pii: maybe`) is an error (HTTP 400), never "off".
- The response carries `onp-pii-masked: EMAIL=1,PHONE=1` (or `none`) when the request was masked; the gateway
  and router ledgers carry the same counts as `pii_masked`. Values are never logged.
- The advisor (`onp/auto`, `auto`) still reads the prompt as written, on this machine, to choose
  offerings: a prompt with personal data still leans to offerings that keep no data.

## What is and isn't covered

Measured on WebTester's synthetic test texts (`WebTester/tests/WebTester.Core.Tests/Pii/`), counting a
value as masked when it no longer appears in the output:

| Detector | Tuning set (57 values) | Held-out set (26 values) | Ordinary text kept |
|---|---|---|---|
| regex (OpenNodes rules, this module) | 22 (39%) | 8 (31%) | 76/76, 31/31 |
| regex + Presidio (WebTester, 2026-10-24) | 52 (91%) | 21 (81%) | 75/76, 30/31 |
| regex + Presidio + Gemma 4 31B on the LAN (WebTester) | 57 (100%) | 26 (100%) | 75/76, 29/31 |

The WebTester figures are from its own benchmark, not re-run through this module. The Presidio and LLM
detectors here use the same service and the same kind of prompt.

**Covered by the rules:** every e-mail, phone, postal code, card number and labelled date of birth in
both sets, and identifiers with a label.

**Not covered by the rules:** people's names, user names and street addresses, which are most of the
personal data in the sets. They need Presidio or a local model. Also not covered:

- bare identifiers without a label (WebTester's 9-digit property PINs; 10+-digit numbers are left out
  because in prompts and code they are mostly timestamps and ids), private IP addresses, IPv6;
- postal codes outside Canada, dates other than labelled dates of birth, and European domestic phone
  formats without `+`;
- personal data in images, audio and files (refused for the open pool instead);
- embeddings of masked text are embeddings of the placeholders: search over them finds the shape of a
  passage, not the person (local embedding models, never masked, are preferred by `onp/auto`);
- the MCP server (`onp mcp`) calls no model, but its `recommend` tool sends the task description to the
  registry as written (not masked): keep personal data out of task descriptions;
- personal data the model infers from what is left ("the CEO of …"): masking hides values, not context;
- a local model detector can be misled by text written to fool it; the rules run regardless.

Placeholders still show the shape of the request (a form with a `[[PERSON_1]]` and an `[[ADDRESS_1]]`).
Masking makes the open pool safer for requests that may carry incidental personal data; requests that
are about a person belong in the trusted pool, marked sensitive.
