// Test helper (not a test file): a passing server-location check (ONP-3 §6.4). The trusted pool needs
// one (ONP-3 §5e), and fixture nodes on loopback cannot be located, so tests record the result the
// registry's location sweep would store (registry location.js checkNodeLocation).

/** Record a passing check for the node's current card: its API host, located in `country`. */
export async function passServerCheck(registry, nodeId, { country = null } = {}) {
  const card = await registry.store.latestCard(nodeId);
  const declared = String(card.node.operator.country).toUpperCase();
  const located = country ?? declared;
  await registry.store.setObservation(nodeId, '_node', 'location', {
    host: new URL(card.endpoints.openai).hostname, declared, checked_at: new Date().toISOString(),
    server: { country: located, city: null, asn: 64500, network: 'Test Hosting', cdn: false },
    verdict: located === declared ? 'match' : 'same_region',
    latency: { verdict: 'consistent', sites: [] },
  });
}

/** A passing check as search results carry it (`offering.jurisdiction.location`), for offerings built in tests. */
export const PASSED_LOCATION = Object.freeze({
  verdict: 'match', server_country: 'DE', network: 'Test Hosting', cdn: false, latency: 'consistent', checked_at: '2026-11-19T00:00:00.000Z',
});
