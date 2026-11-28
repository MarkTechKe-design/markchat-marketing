-- Existing table ONLY: do not apply after fresh sql/markchat-careers.sql setup.
-- Existing private R2 keys remain quarantined until a signed scanner callback promotes them.
-- Apply to exactly the intended D1 database after reviewing PRAGMA table_info.
ALTER TABLE markchat_career_applications
  ADD COLUMN scan_status TEXT NOT NULL DEFAULT 'pending'
  CHECK(scan_status IN ('pending','clean','infected','scan_failed'));
CREATE INDEX IF NOT EXISTS markchat_careers_scan_status
  ON markchat_career_applications(scan_status, submitted_at DESC);
