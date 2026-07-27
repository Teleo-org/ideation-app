CREATE TABLE IF NOT EXISTS project_shares (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES app_users(clerk_user_id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'snapshot')),
  snapshot_state_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS project_shares_project ON project_shares(project_id);
