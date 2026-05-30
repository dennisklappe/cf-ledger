/**
 * Idempotent schema bootstrap so the Worker is self-initializing: a fresh D1
 * (e.g. one provisioned by the Deploy to Cloudflare button) gets its tables on
 * the first request, with no `wrangler d1 execute` step.
 *
 * Keep these statements in sync with db/schema.sql (that file stays the
 * human-readable canonical reference and the `npm run db:init` source).
 */

const DDL = [
  `CREATE TABLE IF NOT EXISTS snapshot (
     day TEXT NOT NULL, kind TEXT NOT NULL, resource_id TEXT NOT NULL,
     name TEXT NOT NULL, metric TEXT NOT NULL, units REAL NOT NULL,
     PRIMARY KEY (day, kind, resource_id, metric))`,
  `CREATE INDEX IF NOT EXISTS snapshot_month ON snapshot (substr(day, 1, 7))`,
  `CREATE TABLE IF NOT EXISTS binding (
     day TEXT NOT NULL, resource_key TEXT NOT NULL, worker TEXT NOT NULL,
     PRIMARY KEY (day, resource_key, worker))`,
  `CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS snapshot_meta (
     day TEXT PRIMARY KEY, created_at TEXT NOT NULL,
     status TEXT NOT NULL, gaps TEXT NOT NULL DEFAULT '[]')`,
];

let ensured = false;

/** Create tables if absent. Runs its DDL once per isolate; cheap and safe. */
export async function ensureSchema(db: D1Database): Promise<void> {
  if (ensured) return;
  await db.batch(DDL.map((s) => db.prepare(s)));
  ensured = true;
}
