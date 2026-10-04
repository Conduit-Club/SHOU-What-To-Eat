-- Authentication is separate from public content and private submissions.
-- OAuth tokens and raw email addresses are never persisted here.
CREATE TABLE auth_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  username TEXT NOT NULL,
  picture TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL,
  UNIQUE (issuer, subject)
);

CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  was_admin INTEGER NOT NULL DEFAULT 0 CHECK (was_admin IN (0, 1)),
  admin_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);

CREATE TABLE auth_login_transactions (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  return_to TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_login_transactions_expiry ON auth_login_transactions(expires_at);
