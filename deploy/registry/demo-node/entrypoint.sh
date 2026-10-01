#!/usr/bin/env sh
# First run: wait for the engine, generate the Node Card config + signing key, declare hardware.
# Every run: serve the card + proxy on :8800 (TLS terminated by Caddy in front).
set -e
ENGINE="${ENGINE_URL:-http://ollama:11434/v1}"
until curl -fs "$ENGINE/models" >/dev/null; do echo "waiting for engine at $ENGINE"; sleep 3; done
if [ ! -f onp-node.toml ]; then
  onp-node init --engine "$ENGINE" --id "$NODE_ID" --public-url "$PUBLIC_URL" --name "$NODE_NAME" --operator "$OPERATOR"
  # Operator declarations: honest demo hardware + description. Pricing stays free (default).
  cat >> onp-node.toml <<EOF

[hardware]
accelerators = [{ type = "${HW_TYPE:-CPU (AMD EPYC, 2 vCPU)}", count = ${HW_COUNT:-1} }]
EOF
  sed -i "s|^country = .*|country = \"${COUNTRY:-DE}\"|" onp-node.toml
  if [ -n "$DESCRIPTION" ]; then sed -i "s|^\[node\]|[node]\ndescription = \"$DESCRIPTION\"|" onp-node.toml; fi
fi
exec onp-node serve --host 0.0.0.0 --port 8800
