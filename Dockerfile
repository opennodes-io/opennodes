# OpenNodes MCP server (stdio) — the image directories such as Glama use to start and inspect it.
# Exposes recommend / search_offerings / get_offering / estimate against the hosted registry
# (override with ONP_REGISTRY). The registry itself ships separately: see deploy/registry/.
FROM node:24-alpine
RUN npm install -g @opennodes/cli@0.1.2 && npm cache clean --force
ENV ONP_REGISTRY=https://registry.opennodes.io
ENTRYPOINT ["onp", "mcp"]
