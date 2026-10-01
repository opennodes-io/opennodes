# Releasing

Publishing is token-free: `.github/workflows/publish.yml` uses OIDC trusted publishing on npm and PyPI. Nothing to store in GitHub secrets.

## One-time setup (registry side)

**npm** — for each of `@opennodes/core`, `@opennodes/cli`, `@opennodes/registry`, `@opennodes/ollama-router`: package page → *Settings* → *Publishing access* → **Add trusted publisher** → GitHub Actions: organization `opennodes-io`, repository `opennodes`, workflow filename `publish.yml`, environment blank. Optionally set "Require two-factor authentication or a trusted publisher" so classic tokens cannot publish at all.

**PyPI** — project `onp-node` → *Manage* → *Publishing* → **Add a new publisher** → GitHub: owner `opennodes-io`, repository `opennodes`, workflow `publish.yml`, environment blank.

## Each release

1. Bump the versions you intend to ship (`impl/packages/*/package.json`, `node-kit/pyproject.toml`, `impl/packages/cli/server.json`, `deploy/registry/Dockerfile` for the registry image).
2. Commit on `master`, mirror to `public-main`, push to `main` as usual.
3. Tag and push: `git tag v0.1.2 && git push github v0.1.2` (or run the workflow manually from the Actions tab).
4. The workflow publishes only packages whose version is not yet on the registry, in dependency order, with provenance.
5. Registry server: `ssh root@registry-1 'cd /opt/opennodes && git -C /tmp/opennodes pull 2>/dev/null; docker compose up -d --build'` after updating `Dockerfile` there (or copy the new Dockerfile first).
