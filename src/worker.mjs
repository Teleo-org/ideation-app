import { createClerkClient } from '@clerk/backend';
import { Webhook } from 'svix';
import { validateProjectDocument, ProjectValidationError } from './shared/project-document.mjs';

const SLOT_LIMIT = 20;
const ANALYTICS_MAX_BODY_BYTES = 64 * 1024;
const POSTHOG_INGEST_HOSTS = new Set(['us.i.posthog.com', 'eu.i.posthog.com']);
const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const error = (message, status = 400) => json({ error: message }, status);
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const safeJson = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
const shareSlug = (name) => `${String(name || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72) || 'project'}-${id().replaceAll('-', '').slice(0, 12)}`;

function defaultState(name = 'My Ideation Project') {
  const themeId = id();
  const stamp = now();
  return { version: 2, meta: { id: id(), name, createdAt: stamp, updatedAt: stamp }, themes: [{ id: themeId, name: 'Core', parentId: null, hiddenInheritedImplementationIds: [], hiddenInheritedConflictIds: [] }], ideaGroups: [], implementationGroups: [], ideas: [], implementations: [], groupLinks: [], conflicts: [], requirements: [], savedViews: [], uiByTheme: { [themeId]: { lockedImplementationIds: [], visibleImplementationIds: [], previousVisibleImplementationIds: [], manuallyLockedImplementationIds: [], selectedImplementationIds: [], expandedIdeaIds: [], expandedImplementationIds: [], showExcluded: true, search: '', ideaGroupFilterIds: [], knownImplementationIds: [] } }, activeThemeId: themeId };
}

function securityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  headers.set('x-frame-options', 'DENY');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function proxyAnalyticsEvent(request, env, url) {
  if (request.method !== 'POST' || url.pathname !== '/analytics/e/') return error('Not found.', 404);
  let upstreamUrl;
  try {
    upstreamUrl = new URL('/e/', env.POSTHOG_HOST);
    upstreamUrl.search = url.search;
  } catch { return error('Analytics is unavailable.', 503); }
  if (upstreamUrl.protocol !== 'https:' || !POSTHOG_INGEST_HOSTS.has(upstreamUrl.hostname)) return error('Analytics is unavailable.', 503);

  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (!Number.isFinite(declaredLength) || declaredLength > ANALYTICS_MAX_BODY_BYTES) return error('Analytics event is too large.', 413);
  const body = await request.arrayBuffer();
  if (body.byteLength > ANALYTICS_MAX_BODY_BYTES) return error('Analytics event is too large.', 413);

  const headers = new Headers({ accept: 'application/json' });
  const contentType = request.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  try {
    const upstream = await fetch(upstreamUrl, { method: 'POST', headers, body });
    return new Response(null, { status: upstream.status, headers: { 'cache-control': 'no-store' } });
  } catch { return error('Analytics is temporarily unavailable.', 502); }
}

async function authenticate(request, env) {
  if (!env.CLERK_SECRET_KEY || !env.CLERK_PUBLISHABLE_KEY) return null;
  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY, publishableKey: env.CLERK_PUBLISHABLE_KEY });
  const result = await clerk.authenticateRequest(request, { authorizedParties: [env.APP_ORIGIN] });
  if (!result.isAuthenticated) return null;
  return result.toAuth().userId || null;
}

async function provisionedUser(env, userId) {
  if (!userId) return null;
  let user = await env.DB.prepare('SELECT clerk_user_id, email, provisioned FROM app_users WHERE clerk_user_id = ?').bind(userId).first();
  if (!user && env.CLERK_SECRET_KEY && env.CLERK_PUBLISHABLE_KEY) {
    const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY, publishableKey: env.CLERK_PUBLISHABLE_KEY });
    const clerkUser = await clerk.users.getUser(userId);
    const email = String(clerkUser.emailAddresses?.find((entry) => entry.id === clerkUser.primaryEmailAddressId)?.emailAddress || clerkUser.emailAddresses?.[0]?.emailAddress || '').toLowerCase();
    if (email) {
      const stamp = now();
      const invited = await env.DB.prepare('SELECT email FROM invited_emails WHERE email = ?').bind(email).first();
      const selfServiceCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM registration_ledger WHERE source = 'self_service'").first();
      const source = invited ? 'invite' : 'self_service';
      const provisioned = Boolean(invited || Number(selfServiceCount?.count || 0) < SLOT_LIMIT);
      await env.DB.batch([
        env.DB.prepare('INSERT OR IGNORE INTO registration_ledger (clerk_user_id, source, registered_at) VALUES (?, ?, ?)').bind(userId, source, stamp),
        env.DB.prepare('INSERT INTO app_users (clerk_user_id, email, provisioned, provisioned_at, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(clerk_user_id) DO NOTHING').bind(userId, email, provisioned ? 1 : 0, provisioned ? stamp : null, stamp),
      ]);
      user = await env.DB.prepare('SELECT clerk_user_id, email, provisioned FROM app_users WHERE clerk_user_id = ?').bind(userId).first();
    }
  }
  return user?.provisioned ? user : null;
}

async function currentProject(env, ownerId) {
  let project = await env.DB.prepare('SELECT * FROM projects WHERE owner_id = ? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 1').bind(ownerId).first();
  if (!project) {
    const projectId = id(); const stamp = now(); const state = defaultState();
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO workspaces (id, kind, name, created_at) VALUES (?, 'personal', 'Personal workspace', ?)").bind(ownerId, stamp),
      env.DB.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id, clerk_user_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(ownerId, ownerId, stamp),
      env.DB.prepare('INSERT INTO projects (id, owner_id, workspace_id, name, state_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)').bind(projectId, ownerId, ownerId, state.meta.name, JSON.stringify(state), stamp, stamp),
    ]);
    project = await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(projectId).first();
  }
  return project;
}

async function requireWorkspace(request, env) {
  const userId = await authenticate(request, env);
  if (!userId) return { response: error('Sign in is required for cloud storage.', 401) };
  const user = await provisionedUser(env, userId);
  if (!user) return { response: error('Cloud storage is not available for this account.', 403) };
  return { userId, user };
}

async function handleWebhook(request, env) {
  if (!env.CLERK_WEBHOOK_SIGNING_SECRET) return error('Webhook signing secret is not configured.', 503);
  const body = await request.text();
  let event;
  try { event = new Webhook(env.CLERK_WEBHOOK_SIGNING_SECRET).verify(body, Object.fromEntries(request.headers)); }
  catch { return error('Invalid webhook signature.', 400); }
  const stamp = now(); const data = event.data || {};
  if (event.type === 'invitation.created' && data.email_address) {
    await env.DB.prepare('INSERT OR REPLACE INTO invited_emails (email, created_at) VALUES (?, ?)').bind(String(data.email_address).toLowerCase(), stamp).run();
  }
  if (event.type === 'user.created') {
    const email = String(data.email_addresses?.find((entry) => entry.id === data.primary_email_address_id)?.email_address || data.email_addresses?.[0]?.email_address || '').toLowerCase();
    if (!email || !data.id) return error('User event did not include a primary email address.', 400);
    const invited = await env.DB.prepare('SELECT email FROM invited_emails WHERE email = ?').bind(email).first();
    const selfServiceCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM registration_ledger WHERE source = 'self_service'").first();
    const source = invited ? 'invite' : 'self_service';
    const provisioned = Boolean(invited || Number(selfServiceCount?.count || 0) < SLOT_LIMIT);
    await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO registration_ledger (clerk_user_id, source, registered_at) VALUES (?, ?, ?)').bind(data.id, source, stamp),
      env.DB.prepare('INSERT INTO app_users (clerk_user_id, email, provisioned, provisioned_at, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(clerk_user_id) DO UPDATE SET email = excluded.email, provisioned = MAX(app_users.provisioned, excluded.provisioned), provisioned_at = COALESCE(app_users.provisioned_at, excluded.provisioned_at)').bind(data.id, email, provisioned ? 1 : 0, provisioned ? stamp : null, stamp),
    ]);
  }
  if (event.type === 'user.deleted' && data.id) await env.DB.prepare('DELETE FROM app_users WHERE clerk_user_id = ?').bind(data.id).run();
  return json({ ok: true });
}

function attachmentResponse(object, request) {
  if (!object) return error('Attachment not found.', 404);
  const headers = new Headers(); object.writeHttpMetadata(headers); headers.set('etag', object.httpEtag); headers.set('cache-control', 'private, no-store');
  if (request.method === 'HEAD') return new Response(null, { headers });
  return new Response(object.body, { headers });
}

async function publicSharePage(request, env, url) {
  if (request.method !== 'GET' || !/^\/[a-z0-9][a-z0-9-]*$/i.test(url.pathname)) return null;
  const slug = decodeURIComponent(url.pathname.slice(1));
  const share = await env.DB.prepare("SELECT id FROM project_shares WHERE slug = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)").bind(slug, now()).first();
  if (!share) return null;
  const asset = await env.ASSETS.fetch(new Request(new URL('/share.html', url).toString()));
  const headers = new Headers(asset.headers);
  headers.set('cache-control', 'no-store');
  headers.set('x-robots-tag', 'noindex, nofollow, noarchive');
  return new Response(asset.body, { status: asset.status, headers });
}

function projectSummary(project) {
  const state = safeJson(project.state_json, {});
  return {
    id: project.id,
    name: project.name,
    revision: Number(project.revision || 1),
    createdAt: project.created_at,
    updatedAt: project.updated_at,
    archivedAt: project.archived_at || null,
    counts: {
      ideas: state.ideas?.length || 0,
      implementations: state.implementations?.length || 0,
      themes: state.themes?.length || 0,
    },
  };
}

async function ownedProject(env, ownerId, projectId, { includeArchived = false } = {}) {
  const archived = includeArchived ? '' : ' AND archived_at IS NULL';
  return env.DB.prepare(`SELECT * FROM projects WHERE id = ? AND owner_id = ?${archived}`).bind(projectId, ownerId).first();
}

async function saveProjectState(request, env, workspace, project) {
  const body = await request.json().catch(() => null);
  const candidate = body?.state || (body?.meta ? body : null);
  if (!candidate) return error('Invalid project state.');
  let state;
  try { state = validateProjectDocument(candidate); }
  catch (cause) {
    if (cause instanceof ProjectValidationError) return json({ error: cause.message, issues: cause.issues }, 422);
    throw cause;
  }
  const expected = Number(body?.baseRevision ?? project.revision ?? 1);
  const currentRevision = Number(project.revision || 1);
  if (!body?.force && expected !== currentRevision) return json({ error: 'Project changed since it was loaded.', revision: currentRevision, state: safeJson(project.state_json) }, 409);

  const referenced = new Set((state.implementations || []).flatMap((implementation) => (implementation.attachments || []).map((attachment) => attachment.storageName || attachment.id).filter(Boolean)));
  const stored = await env.DB.prepare('SELECT id, r2_key FROM attachments WHERE project_id = ? AND owner_id = ?').bind(project.id, workspace.userId).all();
  const storedIds = new Set((stored.results || []).map((attachment) => attachment.id));
  const missingAttachments = [...referenced].filter((attachmentId) => !storedIds.has(attachmentId));
  if (missingAttachments.length) return json({ error: 'Project references attachments that have not been uploaded.', missingAttachments }, 422);

  state.meta ||= {};
  state.meta.updatedAt = now();
  state.meta.name = String(state.meta.name || project.name).slice(0, 160);
  const nextRevision = currentRevision + 1;
  const saved = await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO project_revisions (id, project_id, revision, state_json, created_at) VALUES (?, ?, ?, ?, ?)').bind(id(), project.id, currentRevision, project.state_json, now()),
    env.DB.prepare('UPDATE projects SET name = ?, state_json = ?, revision = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND revision = ?').bind(state.meta.name, JSON.stringify(state), nextRevision, state.meta.updatedAt, project.id, workspace.userId, currentRevision),
  ]);
  if (!saved[1]?.meta?.changes) {
    const latest = await ownedProject(env, workspace.userId, project.id, { includeArchived: true });
    return json({ error: 'Project changed while it was being saved.', revision: Number(latest?.revision || currentRevision), state: safeJson(latest?.state_json) }, 409);
  }
  await env.DB.prepare("DELETE FROM project_revisions WHERE project_id = ? AND (created_at < datetime('now', '-30 days') OR id NOT IN (SELECT id FROM project_revisions WHERE project_id = ? ORDER BY revision DESC LIMIT 100))").bind(project.id, project.id).run();
  const unreferenced = (stored.results || []).filter((attachment) => !referenced.has(attachment.id));
  await Promise.all(unreferenced.map((attachment) => env.ATTACHMENTS.delete(attachment.r2_key)));
  if (unreferenced.length) await env.DB.batch(unreferenced.map((attachment) => env.DB.prepare('DELETE FROM attachments WHERE id = ?').bind(attachment.id)));
  return json({ projectId: project.id, revision: nextRevision, state });
}

async function createProjectShare(request, env, workspace, project) {
  const body = await request.json().catch(() => null);
  const mode = body?.mode;
  if (mode !== 'live' && mode !== 'snapshot') return error('Choose a live or snapshot share.');
  let expiresAt = null;
  if (body?.expiresAt) {
    const parsed = new Date(body.expiresAt);
    if (!Number.isFinite(parsed.getTime()) || parsed <= new Date()) return error('Share expiry must be a future date.');
    expiresAt = parsed.toISOString();
  }
  let slug = ''; let created = false; const shareId = id();
  for (let attempt = 0; attempt < 3 && !created; attempt += 1) {
    slug = shareSlug(project.name);
    try {
      await env.DB.prepare('INSERT INTO project_shares (id, project_id, owner_id, slug, mode, snapshot_state_json, view_json, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(shareId, project.id, workspace.userId, slug, mode, mode === 'snapshot' ? project.state_json : null, body?.view ? JSON.stringify(body.view) : null, expiresAt, now()).run();
      created = true;
    } catch (cause) {
      if (attempt === 2) throw cause;
    }
  }
  return json({ id: shareId, slug, mode, expiresAt, url: `${env.APP_ORIGIN}/${slug}` }, 201);
}

async function uploadProjectAttachment(request, env, workspace, project, url) {
  const filename = String(url.searchParams.get('filename') || 'attachment.bin').replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 180);
  const declaredSize = Number(request.headers.get('content-length') || 0);
  if (declaredSize > 100 * 1024 * 1024) return error('Attachments are limited to 100 MB.', 413);
  const attachmentId = id();
  const key = `${workspace.userId}/${project.id}/${attachmentId}-${filename}`;
  const mime = request.headers.get('content-type') || 'application/octet-stream';
  const object = await env.ATTACHMENTS.put(key, request.body, { httpMetadata: { contentType: mime } });
  const size = Number(object?.size || declaredSize);
  if (size > 100 * 1024 * 1024) {
    await env.ATTACHMENTS.delete(key);
    return error('Attachments are limited to 100 MB.', 413);
  }
  await env.DB.prepare('INSERT INTO attachments (id, owner_id, project_id, r2_key, name, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(attachmentId, workspace.userId, project.id, key, filename, mime, size, now()).run();
  return json({ id: attachmentId, name: filename, storageName: attachmentId, mime, size, url: `/attachments/${attachmentId}` }, 201);
}

async function api(request, env, url) {
  if (request.method === 'GET' && url.pathname === '/api/config') return json({ clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY || '', appOrigin: env.APP_ORIGIN, posthogProjectToken: env.POSTHOG_PROJECT_TOKEN || '', posthogHost: env.POSTHOG_HOST || '' });
  if (request.method === 'POST' && url.pathname === '/api/webhooks/clerk') return handleWebhook(request, env);
  if (request.method === 'GET' && url.pathname === '/api/status') {
    const userId = await authenticate(request, env);
    if (!userId) return json({ authenticated: false, provisioned: false });
    const user = await provisionedUser(env, userId);
    if (!user) return json({ authenticated: true, provisioned: false });
    const project = await currentProject(env, userId);
    return json({ authenticated: true, provisioned: true, open: true, path: 'Private cloud workspace', projectId: project.id, revision: Number(project.revision || 1), state: JSON.parse(project.state_json) });
  }
  if (request.method === 'GET' && url.pathname.startsWith('/api/public-shares/')) {
    const slug = decodeURIComponent(url.pathname.slice('/api/public-shares/'.length));
    const share = await env.DB.prepare("SELECT shares.mode, shares.snapshot_state_json, shares.view_json, projects.state_json FROM project_shares shares JOIN projects ON projects.id = shares.project_id WHERE shares.slug = ? AND shares.revoked_at IS NULL AND (shares.expires_at IS NULL OR shares.expires_at > ?)").bind(slug, now()).first();
    if (!share) return error('Shared project not found.', 404);
    const state = JSON.parse(share.mode === 'snapshot' ? share.snapshot_state_json : share.state_json);
    const response = json({ mode: share.mode, state, view: safeJson(share.view_json) });
    const headers = new Headers(response.headers); headers.set('x-robots-tag', 'noindex, nofollow, noarchive');
    return new Response(response.body, { status: response.status, headers });
  }
  const workspace = await requireWorkspace(request, env);
  if (workspace.response) return workspace.response;

  if (request.method === 'GET' && url.pathname === '/api/projects') {
    const includeArchived = url.searchParams.get('archived') === 'true';
    const rows = await env.DB.prepare(`SELECT * FROM projects WHERE owner_id = ? ${includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY updated_at DESC`).bind(workspace.userId).all();
    return json({ projects: (rows.results || []).map(projectSummary) });
  }
  if (request.method === 'POST' && url.pathname === '/api/projects') {
    const body = await request.json().catch(() => ({}));
    const stamp = now();
    const state = validateProjectDocument(body?.state || defaultState(String(body?.name || 'My Ideation Project').slice(0, 160)));
    const projectId = id();
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO workspaces (id, kind, name, created_at) VALUES (?, 'personal', 'Personal workspace', ?)").bind(workspace.userId, stamp),
      env.DB.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id, clerk_user_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(workspace.userId, workspace.userId, stamp),
      env.DB.prepare('INSERT INTO projects (id, owner_id, workspace_id, name, state_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)').bind(projectId, workspace.userId, workspace.userId, state.meta.name, JSON.stringify(state), stamp, stamp),
    ]);
    return json({ project: projectSummary({ id: projectId, name: state.meta.name, state_json: JSON.stringify(state), revision: 1, created_at: stamp, updated_at: stamp }), state }, 201);
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/(state|shares|revisions|attachments))?(?:\/([^/]+))?$/);
  if (projectMatch) {
    const projectId = decodeURIComponent(projectMatch[1]);
    const resource = projectMatch[2] || '';
    const resourceId = projectMatch[3] ? decodeURIComponent(projectMatch[3]) : '';
    const project = await ownedProject(env, workspace.userId, projectId, { includeArchived: request.method === 'PATCH' });
    if (!project) return error('Project not found.', 404);

    if (!resource && request.method === 'GET') return json({ project: projectSummary(project), state: safeJson(project.state_json) });
    if (!resource && request.method === 'PATCH') {
      const body = await request.json().catch(() => ({}));
      const name = body.name === undefined ? project.name : String(body.name).trim().slice(0, 160);
      const archivedAt = body.archived === undefined ? project.archived_at : (body.archived ? now() : null);
      if (!name) return error('Project name is required.');
      await env.DB.prepare('UPDATE projects SET name = ?, archived_at = ?, updated_at = ? WHERE id = ? AND owner_id = ?').bind(name, archivedAt, now(), project.id, workspace.userId).run();
      const updated = await ownedProject(env, workspace.userId, project.id, { includeArchived: true });
      return json({ project: projectSummary(updated) });
    }
    if (!resource && request.method === 'DELETE') {
      await env.DB.prepare('UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ? AND owner_id = ?').bind(now(), now(), project.id, workspace.userId).run();
      return json({ ok: true });
    }
    if (resource === 'state' && request.method === 'GET') return json({ projectId: project.id, revision: Number(project.revision || 1), state: safeJson(project.state_json) });
    if (resource === 'state' && request.method === 'PUT') return saveProjectState(request, env, workspace, project);
    if (resource === 'revisions' && !resourceId && request.method === 'GET') {
      const rows = await env.DB.prepare('SELECT id, revision, label, created_at FROM project_revisions WHERE project_id = ? ORDER BY revision DESC LIMIT 100').bind(project.id).all();
      return json({ revisions: rows.results || [] });
    }
    if (resource === 'revisions' && !resourceId && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const checkpointId = id();
      const label = String(body.label || 'Checkpoint').slice(0, 160);
      await env.DB.prepare('INSERT INTO project_revisions (id, project_id, revision, state_json, label, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, revision) DO UPDATE SET label = excluded.label').bind(checkpointId, project.id, Number(project.revision || 1), project.state_json, label, now()).run();
      const checkpoint = await env.DB.prepare('SELECT id, revision, label, created_at FROM project_revisions WHERE project_id = ? AND revision = ?').bind(project.id, Number(project.revision || 1)).first();
      return json({ revision: checkpoint }, 201);
    }
    if (resource === 'revisions' && resourceId && request.method === 'GET') {
      const revision = await env.DB.prepare('SELECT id, revision, label, state_json, created_at FROM project_revisions WHERE id = ? AND project_id = ?').bind(resourceId, project.id).first();
      return revision ? json({ id: revision.id, revision: revision.revision, label: revision.label, createdAt: revision.created_at, state: safeJson(revision.state_json) }) : error('Revision not found.', 404);
    }
    if (resource === 'shares' && request.method === 'GET') {
      const rows = await env.DB.prepare('SELECT id, slug, mode, expires_at, revoked_at, created_at FROM project_shares WHERE project_id = ? AND owner_id = ? ORDER BY created_at DESC').bind(project.id, workspace.userId).all();
      return json({ shares: (rows.results || []).map((share) => ({ id: share.id, slug: share.slug, mode: share.mode, expiresAt: share.expires_at, revokedAt: share.revoked_at, createdAt: share.created_at, url: `${env.APP_ORIGIN}/${share.slug}` })) });
    }
    if (resource === 'shares' && !resourceId && request.method === 'POST') return createProjectShare(request, env, workspace, project);
    if (resource === 'shares' && resourceId && request.method === 'DELETE') {
      const result = await env.DB.prepare('UPDATE project_shares SET revoked_at = ? WHERE id = ? AND project_id = ? AND owner_id = ?').bind(now(), resourceId, project.id, workspace.userId).run();
      return result.meta?.changes ? json({ ok: true }) : error('Share not found.', 404);
    }
    if (resource === 'attachments' && !resourceId && request.method === 'POST') return uploadProjectAttachment(request, env, workspace, project, url);
    if (resource === 'attachments' && resourceId && request.method === 'DELETE') {
      const record = await env.DB.prepare('SELECT r2_key FROM attachments WHERE id = ? AND project_id = ? AND owner_id = ?').bind(resourceId, project.id, workspace.userId).first();
      if (!record) return error('Attachment not found.', 404);
      await env.ATTACHMENTS.delete(record.r2_key);
      await env.DB.prepare('DELETE FROM attachments WHERE id = ?').bind(resourceId).run();
      return json({ ok: true });
    }
  }

  const project = await currentProject(env, workspace.userId);
  if (request.method === 'GET' && url.pathname === '/api/state') return json({ projectId: project.id, revision: Number(project.revision || 1), state: JSON.parse(project.state_json) });
  if (request.method === 'PUT' && url.pathname === '/api/state') return saveProjectState(request, env, workspace, project);
  if (request.method === 'POST' && url.pathname === '/api/shares') {
    return createProjectShare(request, env, workspace, project);
  }
  if (request.method === 'POST' && url.pathname === '/api/attachments') {
    return uploadProjectAttachment(request, env, workspace, project, url);
  }
  if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname.startsWith('/attachments/')) {
    const attachmentId = decodeURIComponent(url.pathname.slice('/attachments/'.length)); const record = await env.DB.prepare('SELECT r2_key FROM attachments WHERE id = ? AND owner_id = ?').bind(attachmentId, workspace.userId).first();
    return attachmentResponse(await env.ATTACHMENTS.get(record?.r2_key), request);
  }
  if (request.method === 'DELETE' && url.pathname.startsWith('/api/attachments/')) {
    const attachmentId = decodeURIComponent(url.pathname.slice('/api/attachments/'.length)); const record = await env.DB.prepare('SELECT r2_key FROM attachments WHERE id = ? AND owner_id = ?').bind(attachmentId, workspace.userId).first();
    if (!record) return error('Attachment not found.', 404); await env.ATTACHMENTS.delete(record.r2_key); await env.DB.prepare('DELETE FROM attachments WHERE id = ?').bind(attachmentId).run(); return json({ ok: true });
  }
  return error('Not found.', 404);
}

export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (request.headers.get('x-forwarded-proto') === 'http') {
    url.protocol = 'https:';
    return Response.redirect(url.toString(), 308);
  }
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/attachments/')) return securityHeaders(await api(request, env, url));
  if (url.pathname.startsWith('/analytics/')) return securityHeaders(await proxyAnalyticsEvent(request, env, url));
  if (url.pathname === '/favicon.ico') return securityHeaders(await env.ASSETS.fetch(new Request(new URL('/favicon.svg', url).toString(), request)));
  const shared = await publicSharePage(request, env, url);
  if (shared) return securityHeaders(shared);
  return securityHeaders(await env.ASSETS.fetch(request));
} };
