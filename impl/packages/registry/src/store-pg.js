// Postgres storage driver (production). Same async contract as the sqlite driver.
// Accepts a connection string, or an injected pg-compatible Pool (DI for tests: pg-mem).
import pg from 'pg';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY, origin TEXT NOT NULL, card_url TEXT NOT NULL,
    state TEXT NOT NULL, institutional INTEGER DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'registration',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS card_revisions (
    node_id TEXT NOT NULL, revision TEXT NOT NULL, raw TEXT NOT NULL,
    sig_ok INTEGER NOT NULL, fetched_at TEXT NOT NULL,
    PRIMARY KEY (node_id, revision)
  );
  CREATE TABLE IF NOT EXISTS challenges (
    node_id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS probes (
    id SERIAL PRIMARY KEY, node_id TEXT NOT NULL, offering_id TEXT,
    stage TEXT NOT NULL, kind TEXT NOT NULL, ok INTEGER NOT NULL,
    detail TEXT, measured TEXT, at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS transitions (
    id SERIAL PRIMARY KEY, node_id TEXT NOT NULL,
    from_state TEXT, to_state TEXT NOT NULL, reason TEXT, at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS fingerprints (
    artifact TEXT NOT NULL, prompt TEXT NOT NULL, expected_hash TEXT NOT NULL,
    PRIMARY KEY (artifact, prompt)
  );
  CREATE TABLE IF NOT EXISTS observations (
    node_id TEXT NOT NULL, offering_id TEXT NOT NULL, key TEXT NOT NULL,
    value TEXT NOT NULL, at TEXT NOT NULL,
    PRIMARY KEY (node_id, offering_id, key)
  );
`;

export async function createPgStore({ connectionString, pool } = {}) {
  const p = pool ?? new pg.Pool({ connectionString, max: 10 });
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
    await p.query(stmt);
  }
  const now = () => new Date().toISOString();
  const q = async (text, params = []) => (await p.query(text, params)).rows;

  return {
    driver: 'postgres',
    async upsertNode(id, origin, cardUrl, state, source = 'registration') {
      await q(`INSERT INTO nodes (id, origin, card_url, state, source, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (id) DO UPDATE SET origin=excluded.origin, card_url=excluded.card_url,
          source=excluded.source, updated_at=excluded.updated_at`,
        [id, origin, cardUrl, state, source, now(), now()]);
    },
    async getNode(id) {
      return (await q('SELECT * FROM nodes WHERE id = $1', [id]))[0];
    },
    async setState(id, toState, reason = null) {
      const cur = await this.getNode(id);
      await q('UPDATE nodes SET state = $1, updated_at = $2 WHERE id = $3', [toState, now(), id]);
      await q('INSERT INTO transitions (node_id, from_state, to_state, reason, at) VALUES ($1, $2, $3, $4, $5)',
        [id, cur?.state ?? null, toState, reason, now()]);
    },
    async saveRevision(nodeId, revision, card, sigOk) {
      await q(`INSERT INTO card_revisions (node_id, revision, raw, sig_ok, fetched_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (node_id, revision) DO UPDATE SET raw=excluded.raw,
          sig_ok=excluded.sig_ok, fetched_at=excluded.fetched_at`,
        [nodeId, revision, JSON.stringify(card), sigOk ? 1 : 0, now()]);
    },
    async latestCard(nodeId) {
      const rows = await q('SELECT raw FROM card_revisions WHERE node_id = $1 ORDER BY revision DESC LIMIT 1', [nodeId]);
      return rows[0] ? JSON.parse(rows[0].raw) : null;
    },
    async setChallenge(nodeId, token, ttlMs = 72 * 3600 * 1000) {
      await q(`INSERT INTO challenges (node_id, token, expires_at) VALUES ($1, $2, $3)
        ON CONFLICT (node_id) DO UPDATE SET token=excluded.token, expires_at=excluded.expires_at`,
        [nodeId, token, new Date(Date.now() + ttlMs).toISOString()]);
    },
    async getChallenge(nodeId) {
      const row = (await q('SELECT * FROM challenges WHERE node_id = $1', [nodeId]))[0];
      if (!row || row.expires_at < now()) return null;
      return row;
    },
    async recordProbe(nodeId, offeringId, stage, kind, ok, detail = null, measured = null) {
      await q('INSERT INTO probes (node_id, offering_id, stage, kind, ok, detail, measured, at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [nodeId, offeringId, stage, kind, ok ? 1 : 0, detail, measured ? JSON.stringify(measured) : null, now()]);
    },
    async probesFor(nodeId) {
      return q('SELECT * FROM probes WHERE node_id = $1 ORDER BY id DESC LIMIT 100', [nodeId]);
    },
    async transitionsFor(nodeId) {
      return q('SELECT * FROM transitions WHERE node_id = $1 ORDER BY id ASC', [nodeId]);
    },
    async allNodes() { return q('SELECT * FROM nodes'); },
    async addFingerprints(artifact, refs) {
      for (const ref of refs) {
        await q(`INSERT INTO fingerprints (artifact, prompt, expected_hash) VALUES ($1, $2, $3)
          ON CONFLICT (artifact, prompt) DO UPDATE SET expected_hash=excluded.expected_hash`,
          [artifact, ref.prompt, ref.expected_hash]);
      }
    },
    async getFingerprints(artifact) {
      return q('SELECT prompt, expected_hash FROM fingerprints WHERE artifact = $1', [artifact]);
    },
    async setObservation(nodeId, offeringId, key, value) {
      await q(`INSERT INTO observations (node_id, offering_id, key, value, at) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (node_id, offering_id, key) DO UPDATE SET value=excluded.value, at=excluded.at`,
        [nodeId, offeringId, key, JSON.stringify(value), now()]);
    },
    async getObservations(nodeId, offeringId) {
      const rows = await q('SELECT key, value FROM observations WHERE node_id = $1 AND offering_id = $2', [nodeId, offeringId]);
      return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
    },
    async observationsForNode(nodeId) {
      const rows = await q('SELECT offering_id, key, value FROM observations WHERE node_id = $1', [nodeId]);
      return rows.map((r) => ({ offering_id: r.offering_id, key: r.key, value: JSON.parse(r.value) }));
    },
    async close() { await p.end(); },
  };
}
