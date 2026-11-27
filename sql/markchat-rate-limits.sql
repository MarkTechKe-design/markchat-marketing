-- Run against the Cloudflare D1 database bound as MARKCHAT_RATE_DB.
-- Rate counts use one atomic UPSERT per request.
CREATE TABLE IF NOT EXISTS markchat_rate_limit (
  scope TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, ip_hash)
);
CREATE INDEX IF NOT EXISTS idx_markchat_rate_expiration
  ON markchat_rate_limit(window_start);
-- Optional periodic cleanup:
-- DELETE FROM markchat_rate_limit WHERE window_start < (unixepoch() / 60) - 2880;
