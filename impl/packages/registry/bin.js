#!/usr/bin/env node
import { startRegistry } from './src/server.js';

const dbPath = process.env.ONP_DB ?? ':memory:'; // sqlite path/:memory: or postgres:// URL
const persistent = dbPath !== ':memory:' && !dbPath.startsWith('postgres');
const registry = await startRegistry({
  port: Number(process.env.PORT ?? 4300),
  host: process.env.HOST ?? '127.0.0.1',   // 0.0.0.0 inside containers / behind a reverse proxy
  dbPath,
  // Persistent signing identity: explicit path, or derived from a file db; pg deployments set ONP_REGISTRY_KEY.
  keyPath: process.env.ONP_REGISTRY_KEY ?? (persistent ? `${dbPath}.key.pem` : (dbPath.startsWith('postgres') ? 'onp-registry-key.pem' : null)),
  allowPrivateTargets: process.env.ONP_ALLOW_PRIVATE === '1', // dev only: permit localhost nodes
  registerPerHour: Number(process.env.ONP_REGISTER_PER_HOUR ?? 30),          // per client address
  admitCooldownMs: Number(process.env.ONP_ADMIT_COOLDOWN_MS ?? 30 * 60_000),  // Stage B per node
  trustProxy: process.env.ONP_TRUST_PROXY === '1',                            // behind Caddy / a CDN
  adminToken: process.env.ONP_ADMIN_TOKEN ?? null,
  stageC: process.env.ONP_STAGE_C === '0' ? null : {
    livenessIntervalMs: Number(process.env.ONP_LIVENESS_MS ?? 300_000),
    blindIntervalMs: Number(process.env.ONP_BLIND_MS ?? 3_600_000),
  },
  reimport: process.env.ONP_REIMPORT === '1' ? {
    intervalMs: Number(process.env.ONP_REIMPORT_MS ?? 6 * 3600 * 1000),
    sources: (process.env.ONP_REIMPORT_SOURCES ?? 'openrouter,huggingface').split(','),
  } : null,
});
if (process.env.ONP_ALLOW_PRIVATE === '1') console.log('WARNING: SSRF guard disabled (ONP_ALLOW_PRIVATE=1) — dev only');
console.log(`opennodes registry listening at ${registry.origin}`);
console.log(`health: ${registry.origin}/v0/health`);
