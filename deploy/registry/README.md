# Hosted registry deployment

Single-host stack for `registry.opennodes.io` (or your own registry): PostgreSQL, the published `@opennodes/registry` package, and Caddy for automatic TLS.

```bash
# on an Ubuntu 24.04 host with Docker installed
mkdir -p /opt/opennodes && cp -r deploy/registry/* /opt/opennodes/ && cd /opt/opennodes
./setup.sh            # generates .env, builds, starts, installs daily backups
```

- Edit `Caddyfile` for your hostname; DNS must point at the host before the first start so Caddy can obtain a certificate.
- Secrets live in `.env` (`PG_PASSWORD`, `ONP_ADMIN_TOKEN`); the registry's signing key is persisted in `data/registry-key.pem`.
- Imports run on a 6-hour schedule (`ONP_REIMPORT_SOURCES`); trigger one by hand with `curl -X POST -H "Authorization: Bearer $ONP_ADMIN_TOKEN" https://<host>/v0/import/openrouter -d '{}'`.
- Upgrade: bump the version in `Dockerfile`, then `docker compose up -d --build`.
- Backups: `backup.sh` dumps Postgres daily into `backups/` (14 kept); combine with host-level snapshots.
