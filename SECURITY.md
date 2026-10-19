# Security policy

## Reporting a vulnerability

Email **security@opennodes.io**. Please don't open a public issue for anything that could be exploited.

Include what you found, where (URL, package and version, or spec section), and how to reproduce it. We acknowledge reports within 3 working days and keep you informed until it is fixed. OpenNodes is a small open-source project: there is no bug bounty, but we credit reporters in the release notes unless you prefer otherwise.

## Scope

- The hosted registry at `registry.opennodes.io` (API, web app, MCP endpoint) and `demo-node.opennodes.io`
- The npm packages `@opennodes/core`, `@opennodes/cli`, `@opennodes/registry`, `@opennodes/ollama-router`
- The Python Node Kit `onp-node`
- The protocol specification (ONP-1…6) — design flaws that let a node impersonate another, defeat verification, or misprice an invocation

Of particular interest: listing or claiming a node in a namespace you don't control, leaking operator probe keys, bypassing price pinning or receipt verification, and server-side request forgery through the registry's probes.

Out of scope: nodes and API providers listed in the registry but run by third parties — report those to their operators — and volumetric denial of service.

## Good faith

Test against your own nodes and accounts, avoid degrading the hosted registry for others, and don't access data that isn't yours. We won't pursue research done in that spirit.
