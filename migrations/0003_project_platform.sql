CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'personal' CHECK (kind IN ('personal')),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  clerk_user_id TEXT NOT NULL REFERENCES app_users(clerk_user_id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, clerk_user_id)
);

ALTER TABLE projects ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE projects ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN archived_at TEXT;

INSERT OR IGNORE INTO workspaces (id, kind, name, created_at)
SELECT clerk_user_id, 'personal', 'Personal workspace', created_at FROM app_users;

INSERT OR IGNORE INTO workspace_members (workspace_id, clerk_user_id, role, created_at)
SELECT clerk_user_id, clerk_user_id, 'owner', created_at FROM app_users;

UPDATE projects SET workspace_id = owner_id WHERE workspace_id IS NULL;
CREATE INDEX IF NOT EXISTS projects_workspace_updated ON projects(workspace_id, archived_at, updated_at DESC);

CREATE TABLE IF NOT EXISTS project_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, revision)
);
CREATE INDEX IF NOT EXISTS project_revisions_project_created ON project_revisions(project_id, created_at DESC);

ALTER TABLE project_shares ADD COLUMN expires_at TEXT;
ALTER TABLE project_shares ADD COLUMN revoked_at TEXT;
ALTER TABLE project_shares ADD COLUMN view_json TEXT;
CREATE INDEX IF NOT EXISTS project_shares_owner_active ON project_shares(owner_id, revoked_at, created_at DESC);

ALTER TABLE attachments ADD COLUMN sha256 TEXT;
