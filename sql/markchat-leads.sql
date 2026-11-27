-- Idempotent schema matching the live D1 migration applied on 2026-11-27.
-- Contains customer personal data: do not expose SELECT endpoints publicly.
CREATE TABLE IF NOT EXISTS markchat_leads (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  business_name TEXT NOT NULL DEFAULT '',
  interest TEXT NOT NULL,
  monthly_volume TEXT NOT NULL DEFAULT 'Not specified',
  transcript_summary TEXT NOT NULL DEFAULT '',
  source_page TEXT NOT NULL,
  admin_reply_mailto TEXT NOT NULL,
  notification_sent INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_markchat_leads_created_at ON markchat_leads (created_at DESC);
