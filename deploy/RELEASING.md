# Releasing

Publishing is token-free: `.github/workflows/publish.yml` uses OIDC trusted publishing on npm and PyPI. Nothing to store in GitHub secrets.

## One-time setup (registry side)

**npm** — for each of `@opennodes/core`, `@opennodes/cli`, `@opennodes/registry`, `@opennodes/ollama-router`: package page → *Settings* → *Publishing access* → **Add trusted publisher** → GitHub Actions: organization `opennodes-io`, repository `opennodes`, workflow filename `publish.yml`, environment blank. Optionally set "Require two-factor authentication or a trusted publisher" so classic tokens cannot publish at all.

**PyPI** — project `onp-node` → *Manage* → *Publishing* → **Add a new publisher** → GitHub: owner `opennodes-io`, repository `opennodes`, workflow `publish.yml`, environment blank.

## Each release

The order is: npm packages, then the registry deploy, then onp-node on PyPI last. `publish.yml` never publishes both in one run.

1. Bump the versions you intend to ship (`impl/packages/*/package.json`, `node-kit/pyproject.toml`, `deploy/registry/Dockerfile` for the registry image). Then `node deploy/pin-versions.mjs --own`: each package's own README (it ships in the package, so it is the npm or PyPI page) names the version being released, and `impl/packages/cli/server.json` (the MCP Registry entry) names the cli version. `npm test` fails until it does.
2. Refresh the lockfile and commit it with the bump: `cd impl && npm install --package-lock-only`. The workflow installs with `npm ci`, which fails when `package-lock.json` does not match the package versions.
3. Commit on `master`, mirror to `public-main`, push to `main` as usual.
4. **npm**: tag and push, `git tag v0.1.2 && git push github v0.1.2` (or Actions → *Publish packages* → *Run workflow* with target `npm`). This runs the tests and publishes, in dependency order with provenance, the npm packages whose version is not yet on npm. A tag push never publishes to PyPI.
5. **Pin the live install lines** once the npm packages are out: `node deploy/pin-versions.mjs`. It looks up the latest published version of `@opennodes/cli`, `@opennodes/registry`, `@opennodes/ollama-router` and `onp-node`, and rewrites every install line in the Claude Code plugin (`plugins/opennodes/.mcp.json`), the root `Dockerfile` (the MCP server image directories build from `main`), the site, the root and `impl` READMEs, `docs/`, the Cursor rule, and the lines in a package's files that name another package. A package's lines about itself keep its manifest version (step 1). Name versions to pin something else: `node deploy/pin-versions.mjs cli=0.1.34`. Review the diff, commit, push, then deploy the site. Never pin before publishing: the plugin starts the pinned version on every launch, so a pin to a version that is not on npm yet breaks it. `node deploy/pin-versions.mjs --check` (also part of `npm test`) fails on an unpinned line, a partial version such as `@0.1`, two versions of one package, or a package README or `server.json` that does not name its manifest version.
6. MCP Registry, when the cli changed: Actions → *Publish to the MCP Registry* → *Run workflow* (it needs the new cli on npm).
7. **Registry server**: `ssh root@registry-1 'cd /opt/opennodes && git -C /tmp/opennodes pull 2>/dev/null; docker compose up -d --build'` after updating `Dockerfile` there (or copy the new Dockerfile first).
8. **PyPI, last**: Actions → *Publish packages* → *Run workflow* with target `pypi`. It builds `node-kit` and publishes onp-node if that version is not on PyPI yet. Then `node deploy/pin-versions.mjs` again, so the `pipx install onp-node==…` lines name it; commit, push, deploy the site.

## Pinned tools in CI

The workflows run nothing by a moving name, and `npm test` checks this (`deploy/pin-versions.mjs --check`):

- **Actions** are pinned by full commit SHA, with the tag in a comment: `uses: actions/checkout@<sha> # v4.4.0`. To move one, take the commit of the new tag, never a SHA from a web page: `git ls-remote https://github.com/actions/checkout refs/tags/v4.4.0 'refs/tags/v4.4.0^{}'` (for an annotated tag, the `^{}` line is the commit).
- **npm** is installed at an exact version that supports trusted publishing (11.5.1 or later): `npm install -g npm@12.2.3`. Dependencies come from the lockfile (`npm ci`). The Node Kit builds with `build==1.6.1`.
- **mcp-publisher** (`mcp-registry.yml`) is downloaded at `MCP_PUBLISHER_VERSION` and checked against `MCP_PUBLISHER_SHA256` before it runs. To move to a newer release, take the SHA-256 of `mcp-publisher_linux_amd64.tar.gz` from that release's `registry_<version>_checksums.txt`, and check it against the file you download yourself (`sha256sum`).
