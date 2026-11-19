// The vendor-namespace rule (ONP-3 §6.3): an offering may claim a proprietary artefact,
// urn:proprietary:{vendor}:{model}, only from the vendor's own namespace.
// - A vendor in the registry's table (built-in pins below, overridden by admin entries) is
//   admitted only from a node id inside one of its listed namespaces.
// - A vendor slug that the registry's imported catalogue listings already use (groq, scaleway, …)
//   but that has no entry is admitted only from the domain those listings are served from: a node
//   whose own domain contains the API host of such an import (router hosts do not count, their
//   listings name model authors). The second label alone ignores the TLD, and whoever holds
//   groq.example must not become "groq"; the provider itself, claiming its listing, can.
// - Any other vendor slug is admitted only from the node's own namespace: the slug must equal the
//   second label of the node id (io.acme.gpu1 may claim urn:proprietary:acme:*). This is what the
//   Node Kit writes for a model it cannot name publicly.
// A claim that breaks the rule fails Stage A (`artifact-namespace`), so the node stays unverified.
import { readFileSync } from 'node:fs';

const BUILTIN = JSON.parse(readFileSync(new URL('./data/proprietary-vendors.json', import.meta.url), 'utf8')).vendors;

export const VENDOR_SLUG = /^[a-z0-9-]+$/;
export const NAMESPACE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
/** model.artifact as the schema has it (ONP-2 §5): hf:, ollama: or urn:proprietary:. */
export const ARTIFACT = /^(hf:[^/\s]+\/[^/\s]+|ollama:[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)?(:[A-Za-z0-9._-]+)?|urn:proprietary:[a-z0-9-]+:[A-Za-z0-9._-]+)$/;

/** The vendor slug of a proprietary artefact, or null for any other artefact. */
export const proprietaryVendor = (artifact) => /^urn:proprietary:([a-z0-9-]+):/.exec(String(artifact ?? ''))?.[1] ?? null;

/** The node's own vendor label: the id's second label (io.opennodes.helsinki -> opennodes). */
export const ownLabel = (nodeId) => String(nodeId ?? '').toLowerCase().split('.')[1] ?? null;

/** Whether `nodeId` lies inside `namespace` (equal, or a child of it). */
export const withinNamespace = (nodeId, namespace) => {
  const id = String(nodeId ?? '').toLowerCase();
  return id === namespace || id.startsWith(namespace + '.');
};

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'ne', 'or']);
/**
 * The registrable domain of a node id: its first two labels reversed (io.acme.gpu1 -> acme.io), or
 * three under a country's second-level suffix (uk.co.acme.gpu1 -> acme.co.uk).
 */
export function nodeDomain(nodeId) {
  const labels = String(nodeId ?? '').toLowerCase().split('.');
  const n = labels[0]?.length === 2 && SECOND_LEVEL.has(labels[1]) ? 3 : 2;
  return labels.length >= n ? labels.slice(0, n).reverse().join('.') : null;
}

/**
 * The effective vendor table: built-in pins, with admin entries (rows from the store:
 * [{vendor, namespaces}]) replacing them, and every other slug of `catalog` (Map vendor slug ->
 * API hosts of the imported listings that use it, routers excluded) bound to those hosts.
 * Returns Map vendor -> {namespaces, source, hosts?}.
 */
export function vendorTable(adminRows = [], catalog = new Map()) {
  const table = new Map(Object.entries(BUILTIN).map(([vendor, namespaces]) => [vendor, { namespaces, source: 'built-in' }]));
  for (const row of adminRows) table.set(row.vendor, { namespaces: row.namespaces, source: 'admin' });
  for (const [vendor, hosts] of catalog) if (!table.has(vendor)) table.set(vendor, { namespaces: [], hosts: [...hosts], source: 'catalog' });
  return table;
}

/** Whether `nodeId` may claim `artifact`. Non-proprietary artefacts always may. */
export function vendorClaim(artifact, nodeId, table = vendorTable()) {
  const vendor = proprietaryVendor(artifact);
  if (!vendor) return { ok: true, vendor: null };
  const pinned = table.get(vendor);
  if (pinned?.source === 'catalog') {
    const domain = nodeDomain(nodeId);
    const ok = Boolean(domain) && pinned.hosts.some((h) => h === domain || h.endsWith('.' + domain));
    return { ok, vendor, rule: 'catalog', hosts: pinned.hosts };
  }
  if (pinned) {
    return pinned.namespaces.some((ns) => withinNamespace(nodeId, ns))
      ? { ok: true, vendor, rule: 'listed', namespaces: pinned.namespaces }
      : { ok: false, vendor, rule: 'listed', namespaces: pinned.namespaces };
  }
  return ownLabel(nodeId) === vendor
    ? { ok: true, vendor, rule: 'own-namespace' }
    : { ok: false, vendor, rule: 'own-namespace' };
}

/** One problem per offering of `card` whose proprietary artefact `nodeId` may not claim. */
export function artifactClaimProblems(card, table = vendorTable()) {
  const problems = [];
  for (const o of card?.offerings ?? []) {
    const claim = vendorClaim(o.model?.artifact, card.node?.id, table);
    if (claim.ok) continue;
    problems.push(claim.rule === 'listed'
      ? `${o.offering_id}: ${o.model.artifact} may be claimed only from ${claim.namespaces.join(' or ')}`
      : claim.rule === 'catalog'
        ? `${o.offering_id}: vendor "${claim.vendor}" is known from imported listings${claim.hosts.length ? ` served from ${claim.hosts.slice(0, 3).join(', ')}` : ' reached only through routers'}, so only a node in that domain may claim it (or the registry lists the vendor's namespace)`
        : `${o.offering_id}: ${o.model.artifact} names vendor "${claim.vendor}", but this node's namespace is "${ownLabel(card.node?.id)}"; name open-weight models by a public artefact (hf:, ollama:)`);
  }
  return problems;
}
