#!/usr/bin/env bash
# One-shot setup on the server: run from /opt/opennodes as root.
#   - generates .env secrets on first run (never overwrites)
#   - builds + starts the stack
#   - installs a daily Postgres dump (keeps 14)
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  umask 077
  printf 'PG_PASSWORD=%s\nONP_ADMIN_TOKEN=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > .env
  echo "wrote .env (secrets generated)"
fi
mkdir -p data backups
chmod 700 data

docker compose up -d --build
docker compose ps

# Daily backup at 03:17 server time.
cat > backup.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
docker compose exec -T db pg_dump -U onp onp | gzip > "backups/onp-$(date +%F).sql.gz"
ls -1t backups/onp-*.sql.gz | tail -n +15 | xargs -r rm --
EOF
chmod +x backup.sh
( crontab -l 2>/dev/null | grep -v 'opennodes/backup.sh' ; echo "17 3 * * * /opt/opennodes/backup.sh >> /opt/opennodes/backups/backup.log 2>&1" ) | crontab -
echo "backup cron installed"
