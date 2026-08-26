// Registry storage. The async store API is the seam between drivers:
// - sqlite (node:sqlite): zero-setup dev/tests, file or :memory:
// - postgres (store-pg.js): production, selected by a postgres:// URL
// Every method is async so both drivers present the identical contract.
import { DatabaseSync } from 'node:sqlite';

/** config: ':memory:' | sqlite file path | postgres:// URL */
export async function createStore(config = ':memory:') {
  if (typeof config === 'string' && /^postgres(ql)?:\/\//.test(config)) {
    const { createPgStore } = await import('./store-pg.js');
    return createPgStore({ connectionString: config });
  }
  return createSqliteStore(config);
}

export async function createSqliteStore(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`
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
      id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT NOT NULL, offering_id TEXT,
      stage TEXT NOT NULL, kind TEXT NOT NULL, ok INTEGER NOT NULL,
      detail TEXT, measured TEXT, at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT NOT NULL,
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
  `);

  const now = () => new Date().toISOString();

  return {
    driver: 'sqlite',
    async upsertNode(id, origin, cardUrl, state, source = 'registration') {
      db.prepare(`INSERT INTO nodes (id, origin, card_url, state, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET origin=excluded.origin, card_url=excluded.card_url,
          source=excluded.source, updated_at=excluded.updated_at`)
        .run(id, origin, cardUrl, state, source, now(), now());
    },
    async getNode(id) { return db.prepare('SELECT * FROM nodes WHERE id = ?').get(id); },
    async setState(id, toState, reason = null) {
      const cur = await this.getNode(id);
      db.prepare('UPDATE nodes SET state = ?, updated_at = ? WHERE id = ?').run(toState, now(), id);
      db.prepare('INSERT INTO transitions (node_id, from_state, to_state, reason, at) VALUES (?, ?, ?, ?, ?)')
        .run(id, cur?.state ?? null, toState, reason, now());
    },
    async saveRevision(nodeId, revision, card, sigOk) {
      db.prepare(`INSERT OR REPLACE INTO card_revisions (node_id, revision, raw, sig_ok, fetched_at)
        VALUES (?, ?, ?, ?, ?)`).run(nodeId, revision, JSON.stringify(card), sigOk ? 1 : 0, now());
    },
    async latestCard(nodeId) {
      const row = db.prepare('SELECT raw FROM card_revisions WHERE node_id = ? ORDER BY revision DESC LIMIT 1').get(nodeId);
      return row ? JSON.parse(row.raw) : null;
    },
    async setChallenge(nodeId, token, ttlMs = 72 * 3600 * 1000) {
      db.prepare('INSERT OR REPLACE INTO challenges (node_id, token, expires_at) VALUES (?, ?, ?)')
        .run(nodeId, token, new Date(Date.now() + ttlMs).toISOString());
    },
    async getChallenge(nodeId) {
      const row = db.prepare('SELECT * FROM challenges WHERE node_id = ?').get(nodeId);
      if (!row || row.expires_at < now()) return null;
      return row;
    },
    async recordProbe(nodeId, offeringId, stage, kind, ok, detail = null, measured = null) {
      db.prepare('INSERT INTO probes (node_id, offering_id, stage, kind, ok, detail, measured, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(nodeId, offeringId, stage, kind, ok ? 1 : 0, detail, measured ? JSON.stringify(measured) : null, now());
    },
    async probesFor(nodeId) {
      return db.prepare('SELECT * FROM probes WHERE node_id = ? ORDER BY id DESC LIMIT 100').all(nodeId);
    },
    async transitionsFor(nodeId) {
      return db.prepare('SELECT * FROM transitions WHERE node_id = ? ORDER BY id ASC').all(nodeId);
    },
    async allNodes() { return db.prepare('SELECT * FROM nodes').all(); },
    async addFingerprints(artifact, refs) {
      for (const ref of refs) {
        db.prepare('INSERT OR REPLACE INTO fingerprints (artifact, prompt, expected_hash) VALUES (?, ?, ?)')
          .run(artifact, ref.prompt, ref.expected_hash);
      }
    },
    async getFingerprints(artifact) {
      return db.prepare('SELECT prompt, expected_hash FROM fingerprints WHERE artifact = ?').all(artifact);
    },
    async setObservation(nodeId, offeringId, key, value) {
      db.prepare('INSERT OR REPLACE INTO observations (node_id, offering_id, key, value, at) VALUES (?, ?, ?, ?, ?)')
        .run(nodeId, offeringId, key, JSON.stringify(value), now());
    },
    async getObservations(nodeId, offeringId) {
      const rows = db.prepare('SELECT key, value FROM observations WHERE node_id = ? AND offering_id = ?').all(nodeId, offeringId);
      return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
    },
    async observationsForNode(nodeId) {
      const rows = db.prepare('SELECT offering_id, key, value FROM observations WHERE node_id = ?').all(nodeId);
      return rows.map((r) => ({ offering_id: r.offering_id, key: r.key, value: JSON.parse(r.value) }));
    },
    async close() { db.close(); },
  };
}
