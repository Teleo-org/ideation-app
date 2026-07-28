import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, createReadStream, cpSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { validateProjectDocument } from '../src/shared/project-document.mjs';

const now = () => new Date().toISOString();
const safeJson = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
const referencedAttachmentIds = (state) => new Set((state.implementations || []).flatMap((implementation) => (implementation.attachments || []).map((attachment) => attachment.storageName || attachment.id).filter(Boolean)));

export function defaultState(name = 'My Ideation Project') {
  const themeId = randomUUID(); const stamp = now();
  return validateProjectDocument({ version: 2, meta: { id: randomUUID(), name, createdAt: stamp, updatedAt: stamp }, themes: [{ id: themeId, name: 'Core', parentId: null, hiddenInheritedImplementationIds: [], hiddenInheritedConflictIds: [] }], ideaGroups: [], implementationGroups: [], ideas: [], implementations: [], groupLinks: [], conflicts: [], requirements: [], savedViews: [], uiByTheme: { [themeId]: {} }, activeThemeId: themeId });
}

export class NodeRepositories {
  constructor(dataDirectory) {
    this.dataDirectory = dataDirectory;
    this.attachmentsDirectory = join(dataDirectory, 'attachments');
    mkdirSync(this.attachmentsDirectory, { recursive: true });
    this.db = new DatabaseSync(join(dataDirectory, 'ideation-workbench.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS identities (subject TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_members (workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, subject TEXT NOT NULL REFERENCES identities(subject) ON DELETE CASCADE, role TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (workspace_id, subject));
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES identities(subject), workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, state_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS projects_owner_updated ON projects(owner_id, archived_at, updated_at DESC);
      CREATE TABLE IF NOT EXISTS project_revisions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, revision INTEGER NOT NULL, state_json TEXT NOT NULL, label TEXT, created_at TEXT NOT NULL, UNIQUE(project_id, revision));
      CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, storage_path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_shares (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, owner_id TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, mode TEXT NOT NULL, snapshot_state_json TEXT, view_json TEXT, expires_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL);
    `);
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('project_revisions') WHERE name = 'label'").get()) this.db.exec('ALTER TABLE project_revisions ADD COLUMN label TEXT');
  }

  ensureIdentity(subject) {
    const stamp = now();
    this.db.prepare('INSERT OR IGNORE INTO identities (subject, created_at) VALUES (?, ?)').run(subject, stamp);
    this.db.prepare("INSERT OR IGNORE INTO workspaces (id, kind, name, created_at) VALUES (?, 'personal', 'Personal workspace', ?)").run(subject, stamp);
    this.db.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id, subject, role, created_at) VALUES (?, ?, 'owner', ?)").run(subject, subject, stamp);
  }

  summary(row) {
    const state = safeJson(row.state_json, {});
    return { id: row.id, name: row.name, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, archivedAt: row.archived_at, counts: { ideas: state.ideas?.length || 0, implementations: state.implementations?.length || 0, themes: state.themes?.length || 0 } };
  }

  list(subject, { archived = false } = {}) {
    this.ensureIdentity(subject);
    const rows = this.db.prepare(`SELECT * FROM projects WHERE owner_id = ? ${archived ? '' : 'AND archived_at IS NULL'} ORDER BY updated_at DESC`).all(subject);
    return rows.map((row) => this.summary(row));
  }

  create(subject, state = defaultState()) {
    this.ensureIdentity(subject);
    const document = validateProjectDocument(state);
    const id = randomUUID(); const stamp = now();
    this.db.prepare('INSERT INTO projects (id, owner_id, workspace_id, name, state_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)').run(id, subject, subject, document.meta.name, JSON.stringify(document), stamp, stamp);
    return { project: this.summary(this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id)), state: document };
  }

  get(subject, projectId, includeArchived = false) {
    const row = this.db.prepare(`SELECT * FROM projects WHERE id = ? AND owner_id = ? ${includeArchived ? '' : 'AND archived_at IS NULL'}`).get(projectId, subject);
    return row ? { row, project: this.summary(row), state: safeJson(row.state_json) } : null;
  }

  current(subject) {
    this.ensureIdentity(subject);
    let result = this.db.prepare('SELECT * FROM projects WHERE owner_id = ? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 1').get(subject);
    if (!result) return this.create(subject);
    return { project: this.summary(result), state: safeJson(result.state_json) };
  }

  save(subject, projectId, candidate, { baseRevision, force = false } = {}) {
    const found = this.get(subject, projectId);
    if (!found) return { status: 404 };
    const current = found.row;
    if (!force && Number(baseRevision) !== Number(current.revision)) return { status: 409, revision: current.revision, state: found.state };
    const state = validateProjectDocument(candidate);
    const referenced = referencedAttachmentIds(state);
    const storedAttachmentIds = new Set(this.db.prepare('SELECT id FROM attachments WHERE project_id = ? AND owner_id = ?').all(projectId, subject).map((row) => row.id));
    const missingAttachments = [...referenced].filter((attachmentId) => !storedAttachmentIds.has(attachmentId));
    if (missingAttachments.length) return { status: 422, error: 'Project references attachments that have not been uploaded.', missingAttachments };
    state.meta.updatedAt = now();
    const nextRevision = current.revision + 1;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR IGNORE INTO project_revisions (id, project_id, revision, state_json, created_at) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), projectId, current.revision, current.state_json, now());
      this.db.prepare('UPDATE projects SET name = ?, state_json = ?, revision = ?, updated_at = ? WHERE id = ? AND owner_id = ?').run(state.meta.name, JSON.stringify(state), nextRevision, state.meta.updatedAt, projectId, subject);
      this.db.prepare("DELETE FROM project_revisions WHERE project_id = ? AND (created_at < datetime('now', '-30 days') OR id NOT IN (SELECT id FROM project_revisions WHERE project_id = ? ORDER BY revision DESC LIMIT 100))").run(projectId, projectId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.cleanupProjectAttachments(subject, projectId, state);
    return { status: 200, projectId, revision: nextRevision, state };
  }

  cleanupProjectAttachments(subject, projectId, state) {
    const referenced = referencedAttachmentIds(state);
    const rows = this.db.prepare('SELECT * FROM attachments WHERE project_id = ? AND owner_id = ?').all(projectId, subject);
    for (const row of rows) {
      if (referenced.has(row.id)) continue;
      rmSync(row.storage_path, { force: true });
      this.db.prepare('DELETE FROM attachments WHERE id = ?').run(row.id);
    }
  }

  update(subject, projectId, patch) {
    const found = this.get(subject, projectId, true);
    if (!found) return null;
    const name = patch.name === undefined ? found.row.name : String(patch.name).trim().slice(0, 160);
    const archivedAt = patch.archived === undefined ? found.row.archived_at : (patch.archived ? now() : null);
    this.db.prepare('UPDATE projects SET name = ?, archived_at = ?, updated_at = ? WHERE id = ? AND owner_id = ?').run(name, archivedAt, now(), projectId, subject);
    return this.summary(this.get(subject, projectId, true).row);
  }

  revisions(subject, projectId) {
    if (!this.get(subject, projectId, true)) return null;
    return this.db.prepare('SELECT id, revision, label, created_at AS createdAt FROM project_revisions WHERE project_id = ? ORDER BY revision DESC LIMIT 100').all(projectId);
  }

  checkpoint(subject, projectId, label) {
    const found = this.get(subject, projectId);
    if (!found) return null;
    const checkpointId = randomUUID();
    this.db.prepare('INSERT INTO project_revisions (id, project_id, revision, state_json, label, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, revision) DO UPDATE SET label = excluded.label').run(checkpointId, projectId, found.project.revision, JSON.stringify(found.state), String(label || 'Checkpoint').slice(0, 160), now());
    return this.db.prepare('SELECT id, revision, label, created_at AS createdAt FROM project_revisions WHERE project_id = ? AND revision = ?').get(projectId, found.project.revision);
  }

  revision(subject, projectId, revisionId) {
    if (!this.get(subject, projectId, true)) return null;
    const row = this.db.prepare('SELECT id, revision, label, state_json, created_at AS createdAt FROM project_revisions WHERE id = ? AND project_id = ?').get(revisionId, projectId);
    return row ? { id: row.id, revision: row.revision, label: row.label, createdAt: row.createdAt, state: safeJson(row.state_json) } : null;
  }

  putAttachment(subject, projectId, { name, mime, bytes }) {
    if (!this.get(subject, projectId)) return null;
    const id = randomUUID();
    const cleanName = String(name || 'attachment.bin').replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 180);
    const storagePath = join(this.attachmentsDirectory, `${id}-${cleanName}`);
    writeFileSync(storagePath, bytes);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    this.db.prepare('INSERT INTO attachments (id, owner_id, project_id, storage_path, name, mime, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, subject, projectId, storagePath, cleanName, mime, bytes.length, checksum, now());
    return { id, storageName: id, name: cleanName, mime, size: bytes.length, sha256: checksum, url: `/attachments/${id}` };
  }

  attachment(subject, attachmentId) {
    return this.db.prepare('SELECT * FROM attachments WHERE id = ? AND owner_id = ?').get(attachmentId, subject) || null;
  }

  deleteAttachment(subject, projectId, attachmentId) {
    const row = this.db.prepare('SELECT * FROM attachments WHERE id = ? AND owner_id = ? AND project_id = ?').get(attachmentId, subject, projectId);
    if (!row) return false;
    rmSync(row.storage_path, { force: true });
    this.db.prepare('DELETE FROM attachments WHERE id = ?').run(attachmentId);
    return true;
  }

  listShares(subject, projectId, origin) {
    if (!this.get(subject, projectId, true)) return null;
    return this.db.prepare('SELECT * FROM project_shares WHERE project_id = ? AND owner_id = ? ORDER BY created_at DESC').all(projectId, subject).map((row) => ({ id: row.id, slug: row.slug, mode: row.mode, expiresAt: row.expires_at, revokedAt: row.revoked_at, createdAt: row.created_at, url: `${origin}/${row.slug}` }));
  }

  createShare(subject, projectId, { mode, view, expiresAt }, origin) {
    const found = this.get(subject, projectId);
    if (!found) return null;
    const id = randomUUID();
    const slug = `${found.project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72) || 'project'}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    this.db.prepare('INSERT INTO project_shares (id, project_id, owner_id, slug, mode, snapshot_state_json, view_json, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, projectId, subject, slug, mode, mode === 'snapshot' ? JSON.stringify(found.state) : null, view ? JSON.stringify(view) : null, expiresAt || null, now());
    return { id, slug, mode, expiresAt: expiresAt || null, url: `${origin}/${slug}` };
  }

  revokeShare(subject, projectId, shareId) {
    return this.db.prepare('UPDATE project_shares SET revoked_at = ? WHERE id = ? AND project_id = ? AND owner_id = ?').run(now(), shareId, projectId, subject).changes > 0;
  }

  publicShare(slug) {
    const row = this.db.prepare("SELECT shares.*, projects.state_json FROM project_shares shares JOIN projects ON projects.id = shares.project_id WHERE shares.slug = ? AND shares.revoked_at IS NULL AND (shares.expires_at IS NULL OR shares.expires_at > ?)").get(slug, now());
    if (!row) return null;
    return { mode: row.mode, view: safeJson(row.view_json), state: safeJson(row.mode === 'snapshot' ? row.snapshot_state_json : row.state_json) };
  }

  backup(targetPath) {
    mkdirSync(targetPath, { recursive: true });
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.db.backup?.(join(targetPath, 'ideation-workbench.sqlite'));
    if (!existsSync(join(targetPath, 'ideation-workbench.sqlite'))) writeFileSync(join(targetPath, 'ideation-workbench.sqlite'), readFileSync(join(this.dataDirectory, 'ideation-workbench.sqlite')));
    if (existsSync(this.attachmentsDirectory)) cpSync(this.attachmentsDirectory, join(targetPath, 'attachments'), { recursive: true, force: true });
  }

  close() {
    this.db.close();
  }
}

export { createReadStream };
