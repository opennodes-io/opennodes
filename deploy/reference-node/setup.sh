#!/usr/bin/env bash
# One-shot setup of a reference node on a fresh Ubuntu 24.04 server; run as root from this directory.
#   - installs Docker from Ubuntu's own packages, opens only SSH/HTTP/HTTPS
#   - declares the real CPU (from lscpu) as the node's hardware unless .env sets it
#   - pulls the model and starts Ollama + Node Kit + Caddy
# Afterwards register from anywhere: onp-node register https://registry.opennodes.io (see README.md).
set -euo pipefail
cd "$(dirname "$0")"

# Swap: a 4 GB host with a model on it needs room for spikes, or it freezes instead of slowing down.
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-opennodes.conf && sysctl -q vm.swappiness=10
fi

if ! command -v docker >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq docker.io docker-compose-v2 >/dev/null
  systemctl enable --now docker
fi
if command -v ufw >/dev/null; then
  ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
fi

[ -f .env ] || cp .env.example .env
setting() { sed -n "s/^$1=//p" .env | tail -1; }   # .env values may contain spaces: read, don't source
if [ -z "$(setting HW_TYPE)" ]; then
  cpu="$(lscpu | sed -n 's/^Model name:[[:space:]]*//p' | head -1)"
  sed -i "s|^HW_TYPE=.*|HW_TYPE=${cpu} vCPU (CPU-only)|" .env
fi
if [ -z "$(setting HW_COUNT)" ]; then
  sed -i "s|^HW_COUNT=.*|HW_COUNT=$(nproc)|" .env
fi
mkdir -p node/data

docker compose up -d --build
docker compose ps
