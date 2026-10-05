# The published registry package, pinned. Node 24 for stable node:sqlite + built-in Ed25519.
FROM node:24-alpine
RUN npm install -g @opennodes/registry@0.1.5 && npm cache clean --force
ENV HOST=0.0.0.0 PORT=4300
EXPOSE 4300
CMD ["onp-registry"]
