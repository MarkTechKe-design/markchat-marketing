CREATE TABLE IF NOT EXISTS markchat_career_applications (
  id TEXT PRIMARY KEY,
  career_id TEXT NOT NULL,
  career_title TEXT NOT NULL,
  specialization TEXT NOT NULL,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  location TEXT NOT NULL,
  linkedin_url TEXT NOT NULL,
  github_url TEXT NOT NULL,
  portfolio_url TEXT NOT NULL,
  cover_letter TEXT NOT NULL,
  consent_agreed INTEGER NOT NULL CHECK(consent_agreed=1),
  submitted_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','shortlisted','interview','rejected','hired')),
  scan_status TEXT NOT NULL DEFAULT 'pending' CHECK(scan_status IN ('pending','clean','infected','scan_failed')),
  cv_key TEXT NOT NULL UNIQUE,
  cv_filename TEXT NOT NULL,
  cv_mime TEXT NOT NULL,
  cv_size INTEGER NOT NULL CHECK(cv_size BETWEEN 1 AND 5242880),
  notification_sent INTEGER NOT NULL DEFAULT 0 CHECK(notification_sent IN (0,1))
);
CREATE INDEX IF NOT EXISTS markchat_careers_submitted ON markchat_career_applications(submitted_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS markchat_careers_status ON markchat_career_applications(status, submitted_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS markchat_careers_scan_status ON markchat_career_applications(scan_status, submitted_at DESC);
CREATE TABLE IF NOT EXISTS markchat_career_hero (
  id TEXT PRIMARY KEY CHECK(id='careers'),
  settings_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
