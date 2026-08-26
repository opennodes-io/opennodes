// DS-EXP-01: signed NDJSON mirror feed so downstream registries/aggregators can
// replicate without re-crawling. Each line = { payload, jws } signed by this registry,
// so provenance survives mirroring.
import { signJson } from '@opennodes/core';

export function exportRoutes(store, registryKeys) {
  return [
    ['GET', '/v0/export', async (req, res, { query }) => {
      const since = query.get('since') ?? '';
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      for (const node of await store.allNodes()) {
        if (since && node.updated_at <= since) continue;
        const card = await store.latestCard(node.id);
        const payload = {
          type: 'node',
          node: { id: node.id, origin: node.origin, state: node.state, source: node.source, updated_at: node.updated_at },
          card,
          observations: await store.observationsForNode(node.id),
        };
        const jws = signJson(payload, registryKeys.privateKey, 'registry-1');
        res.write(JSON.stringify({ payload, jws }) + '\n');
      }
      res.end();
    }],
  ];
}
