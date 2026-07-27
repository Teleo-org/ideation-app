import { createClerkClient } from '@clerk/backend';
import { Webhook } from 'svix';

const SLOT_LIMIT = 20;
const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const error = (message, status = 400) => json({ error: message }, status);
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const shareSlug = (name) => `${String(name || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72) || 'project'}-${id().replaceAll('-', '').slice(0, 12)}`;

function defaultState(name = 'My Ideation Project') {
  const themeId = id();
  const stamp = now();
  return { version: 1, meta: { id: id(), name, createdAt: stamp, updatedAt: stamp }, themes: [{ id: themeId, name: 'Core', parentId: null, hiddenInheritedImplementationIds: [], hiddenInheritedConflictIds: [] }], ideaGroups: [], implementationGroups: [], ideas: [], implementations: [], groupLinks: [], conflicts: [], requirements: [], savedViews: [], uiByTheme: { [themeId]: { lockedImplementationIds: [], visibleImplementationIds: [], previousVisibleImplementationIds: [], expandedIdeaIds: [], expandedImplementationIds: [], showExcluded: true, search: '', ideaGroupFilter: 'all', knownImplementationIds: [] } }, activeThemeId: themeId };
}

function securityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  headers.set('x-frame-options', 'DENY');
  headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
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
  let project = await env.DB.prepare('SELECT * FROM projects WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 1').bind(ownerId).first();
  if (!project) {
    const projectId = id(); const stamp = now(); const state = defaultState();
    await env.DB.prepare('INSERT INTO projects (id, owner_id, name, state_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(projectId, ownerId, state.meta.name, JSON.stringify(state), stamp, stamp).run();
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
  const share = await env.DB.prepare('SELECT id FROM project_shares WHERE slug = ?').bind(slug).first();
  if (!share) return null;
  const asset = await env.ASSETS.fetch(new Request(new URL('/share.html', url).toString()));
  const headers = new Headers(asset.headers);
  headers.set('cache-control', 'no-store');
  headers.set('x-robots-tag', 'noindex, nofollow, noarchive');
  return new Response(asset.body, { status: asset.status, headers });
}

async function api(request, env, url) {
  if (request.method === 'GET' && url.pathname === '/api/config') return json({ clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY || '', appOrigin: env.APP_ORIGIN });
  if (request.method === 'POST' && url.pathname === '/api/webhooks/clerk') return handleWebhook(request, env);
  if (request.method === 'GET' && url.pathname === '/api/status') {
    const userId = await authenticate(request, env);
    if (!userId) return json({ authenticated: false, provisioned: false });
    const user = await provisionedUser(env, userId);
    if (!user) return json({ authenticated: true, provisioned: false });
    const project = await currentProject(env, userId);
    return json({ authenticated: true, provisioned: true, open: true, path: 'Private cloud workspace', projectId: project.id, state: JSON.parse(project.state_json) });
  }
  if (request.method === 'GET' && url.pathname.startsWith('/api/public-shares/')) {
    const slug = decodeURIComponent(url.pathname.slice('/api/public-shares/'.length));
    const share = await env.DB.prepare('SELECT shares.mode, shares.snapshot_state_json, projects.state_json FROM project_shares shares JOIN projects ON projects.id = shares.project_id WHERE shares.slug = ?').bind(slug).first();
    if (!share) return error('Shared project not found.', 404);
    const state = JSON.parse(share.mode === 'snapshot' ? share.snapshot_state_json : share.state_json);
    const response = json({ mode: share.mode, state });
    const headers = new Headers(response.headers); headers.set('x-robots-tag', 'noindex, nofollow, noarchive');
    return new Response(response.body, { status: response.status, headers });
  }
  const workspace = await requireWorkspace(request, env);
  if (workspace.response) return workspace.response;
  const project = await currentProject(env, workspace.userId);
  if (request.method === 'GET' && url.pathname === '/api/state') return json(JSON.parse(project.state_json));
  if (request.method === 'PUT' && url.pathname === '/api/state') {
    const state = await request.json().catch(() => null);
    if (!state || typeof state !== 'object') return error('Invalid project state.');
    state.meta ||= {}; state.meta.updatedAt = now(); state.meta.name = String(state.meta.name || project.name).slice(0, 160);
    await env.DB.prepare('UPDATE projects SET name = ?, state_json = ?, updated_at = ? WHERE id = ? AND owner_id = ?').bind(state.meta.name, JSON.stringify(state), state.meta.updatedAt, project.id, workspace.userId).run();
    return json(state);
  }
  if (request.method === 'POST' && url.pathname === '/api/shares') {
    const body = await request.json().catch(() => null);
    const mode = body?.mode;
    if (mode !== 'live' && mode !== 'snapshot') return error('Choose a live or snapshot share.');
    let slug = ''; let created = false;
    for (let attempt = 0; attempt < 3 && !created; attempt += 1) {
      slug = shareSlug(project.name);
      try {
        await env.DB.prepare('INSERT INTO project_shares (id, project_id, owner_id, slug, mode, snapshot_state_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id(), project.id, workspace.userId, slug, mode, mode === 'snapshot' ? project.state_json : null, now()).run();
        created = true;
      } catch (cause) {
        if (attempt === 2) throw cause;
      }
    }
    return json({ slug, mode, url: `${env.APP_ORIGIN}/${slug}` }, 201);
  }
  if (request.method === 'POST' && url.pathname === '/api/attachments') {
    const filename = String(url.searchParams.get('filename') || 'attachment.bin').replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 180);
    const size = Number(request.headers.get('content-length') || 0); if (size > 100 * 1024 * 1024) return error('Attachments are limited to 100 MB.', 413);
    const attachmentId = id(); const key = `${workspace.userId}/${project.id}/${attachmentId}-${filename}`; const mime = request.headers.get('content-type') || 'application/octet-stream';
    await env.ATTACHMENTS.put(key, request.body, { httpMetadata: { contentType: mime } });
    await env.DB.prepare('INSERT INTO attachments (id, owner_id, project_id, r2_key, name, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(attachmentId, workspace.userId, project.id, key, filename, mime, size, now()).run();
    return json({ id: attachmentId, name: filename, storageName: attachmentId, mime, size, url: `/attachments/${attachmentId}` }, 201);
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
  if (url.protocol === 'http:' || request.headers.get('x-forwarded-proto') === 'http') {
    url.protocol = 'https:';
    return Response.redirect(url.toString(), 308);
  }
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/attachments/')) return securityHeaders(await api(request, env, url));
  const shared = await publicSharePage(request, env, url);
  if (shared) return securityHeaders(shared);
  return securityHeaders(await env.ASSETS.fetch(request));
} };
