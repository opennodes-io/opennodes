# @opennodes/core

Shared building blocks of the OpenNodes Protocol (ONP) reference implementation:

- **Node Card** — JSON Schema validation (`validateCard`) and signature verification (`verifyCardSignature`).
- **JWS** — Ed25519 sign/verify with a stable canonical serialization that byte-matches across the JS and Python implementations (`signJson`, `verifyJws`, `generateKeypair`, `keypairFromPem`, `keyFromJwk`).
- **Pricing** — `costForUsage`, `estimateBounds`, `round6`: the arithmetic behind enforceable estimates and receipt checks (`amount = usage × pinned price`).
- **Advisor** — `extractFeatures` (task → routing features, never the text) and `recommend` (deterministic ranking with filters, weighted components, labeled quality basis, explanations, optional scenario, MCP tool categories).
- **HTTP helpers** — tiny router with CORS, problem+json errors, graceful close.

Used by `@opennodes/cli` and `@opennodes/registry`. Part of [OpenNodes](https://opennodes.io) · Apache-2.0.
