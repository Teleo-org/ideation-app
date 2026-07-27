CREATE TABLE IF NOT EXISTS registration_ledger (
  clerk_user_id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('self_service', 'invite')),
  registered_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invited_emails (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_users (
  clerk_user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  provisioned INTEGER NOT NULL DEFAULT 0,
  provisioned_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES app_users(clerk_user_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS projects_owner_updated ON projects(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES app_users(clerk_user_id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_owner_project ON attachments(owner_id, project_id);
