-- The gateway keeps who may use the Moondog model and how many tokens each code used per day.
-- It keeps no conversation and no invite code: only the code's SHA-256.

CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  daily_token_limit INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  invite_id INTEGER NOT NULL REFERENCES invites (id),
  day TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (invite_id, day)
);

CREATE INDEX IF NOT EXISTS usage_day ON usage (day);

-- Requests per invite in the current clock minute, for the per-minute limit. Older rows are deleted.
CREATE TABLE IF NOT EXISTS minute_requests (
  invite_id INTEGER NOT NULL,
  minute INTEGER NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (invite_id, minute)
);
