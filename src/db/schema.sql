-- cf-ledger history store.
-- One row per (day, resource, metric). Storage metrics hold instantaneous GB
-- so that AVERAGING them over a month yields GB-month; counters hold per-day
-- totals so that SUMMING them over a month yields the monthly total.

CREATE TABLE IF NOT EXISTS snapshot (
  day         TEXT NOT NULL,            -- YYYY-MM-DD (UTC)
  kind        TEXT NOT NULL,            -- worker | kv | r2 | d1
  resource_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  metric      TEXT NOT NULL,           -- MetricId, e.g. workers.requests
  units       REAL NOT NULL,
  PRIMARY KEY (day, kind, resource_id, metric)
);
CREATE INDEX IF NOT EXISTS snapshot_month ON snapshot (substr(day, 1, 7));

-- The binding graph as observed each day: which Worker references which
-- resource. Lets us re-attribute history even as bindings change over time.
CREATE TABLE IF NOT EXISTS binding (
  day          TEXT NOT NULL,
  resource_key TEXT NOT NULL,          -- "kind:id" of the bound resource
  worker       TEXT NOT NULL,
  PRIMARY KEY (day, resource_key, worker)
);

-- Credentials and settings entered via the UI "Connect" flow. Falls back to
-- wrangler secrets when empty. MUST sit behind Cloudflare Access: the stored
-- token is read-only but can read your account.
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per snapshot run, for the "last updated" stamp and data-gap banner.
CREATE TABLE IF NOT EXISTS snapshot_meta (
  day        TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,            -- ISO8601
  status     TEXT NOT NULL,           -- ok | partial | error
  gaps       TEXT NOT NULL DEFAULT '[]'
);
