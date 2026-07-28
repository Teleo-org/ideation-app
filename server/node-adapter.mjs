import http from 'node:http';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { resolve, join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeRepositories, defaultState } from './node-repositories.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'build');
const HOST = process.env.IW_HOST || '127.0.0.1';
const PORT = Number(process.env.IW_PORT || 4317);
const DATA_DIRECTORY = resolve(process.env.IW_DATA_DIR || join(ROOT, '.data'));
const BASE_URL = String(process.env.IW_BASE_URL || `http://${HOST}:${PORT}`).replace(/\/$/, '');
const IDENTITY_HEADER = String(process.env.IW_IDENTITY_HEADER || 'x-forwarded-user').toLowerCase();
const TRUSTED_PROXIES = new Set(String(process.env.IW_TRUSTED_PROXY_ADDRESSES || '127.0.0.1,::1,::ffff:127.0.0.1').split(',').map((value) => value.trim()).filter(Boolean));
const MAX_JSON = 4 * 1024 * 1024;
const MAX_ATTACHMENT = 100 * 1024 * 1024;
const repositories = new NodeRepositories(DATA_DIRECTORY);

const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp',
};

function securityHeaders(headers = {}) {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    ...headers,
  };
}

function sendJson(response, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, securityHeaders({ 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', ...extraHeaders }));
  response.end(body);
}

function identity(request) {
  const remote = request.socket.remoteAddress || '';
  if (!TRUSTED_PROXIES.has(remote)) return null;
  const subject = String(request.headers[IDENTITY_HEADER] || '').trim();
  return subject ? { subject } : null;
}

function readBody(request, maximum) {
  return new Promise((resolveBody, reject) => {
    const chunks = []; let total = 0;
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > maximum) {
        reject(Object.assign(new Error('Request is too large.'), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolveBody(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

async function jsonBody(request) {
  const bytes = await readBody(request, MAX_JSON);
  try { return JSON.parse(bytes.toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}

function requireIdentity(request, response) {
  const authenticated = identity(request);
  if (!authenticated) sendJson(response, 401, { error: 'Authentication is required.' });
  return authenticated;
}

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/healthz') return sendJson(response, 200, { ok: true });
  if (request.method === 'GET' && url.pathname === '/readyz') return sendJson(response, 200, { ok: true, storage: 'sqlite' });
  if (request.method === 'GET' && url.pathname === '/api/config') return sendJson(response, 200, { selfHosted: true, authentication: 'trusted-proxy', appOrigin: BASE_URL, clerkPublishableKey: '' });
  if (request.method === 'GET' && url.pathname.startsWith('/api/public-shares/')) {
    const share = repositories.publicShare(decodeURIComponent(url.pathname.slice('/api/public-shares/'.length)));
    return share ? sendJson(response, 200, share, { 'x-robots-tag': 'noindex, nofollow, noarchive' }) : sendJson(response, 404, { error: 'Shared project not found.' });
  }

  const authenticated = requireIdentity(request, response);
  if (!authenticated) return;
  const subject = authenticated.subject;
  if (request.method === 'GET' && url.pathname === '/api/status') {
    const current = repositories.current(subject);
    return sendJson(response, 200, { authenticated: true, provisioned: true, open: true, path: 'Self-hosted workspace', projectId: current.project.id, revision: current.project.revision, state: current.state });
  }
  if (request.method === 'GET' && url.pathname === '/api/projects') return sendJson(response, 200, { projects: repositories.list(subject, { archived: url.searchParams.get('archived') === 'true' }) });
  if (request.method === 'POST' && url.pathname === '/api/projects') {
    const body = await jsonBody(request);
    const result = repositories.create(subject, body.state || defaultState(String(body.name || 'My Ideation Project').slice(0, 160)));
    return sendJson(response, 201, result);
  }

  const match = url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/(state|shares|revisions|attachments))?(?:\/([^/]+))?$/);
  if (match) {
    const projectId = decodeURIComponent(match[1]); const resource = match[2] || ''; const resourceId = match[3] ? decodeURIComponent(match[3]) : '';
    const found = repositories.get(subject, projectId, request.method === 'PATCH');
    if (!found) return sendJson(response, 404, { error: 'Project not found.' });
    if (!resource && request.method === 'GET') return sendJson(response, 200, { project: found.project, state: found.state });
    if (!resource && request.method === 'PATCH') return sendJson(response, 200, { project: repositories.update(subject, projectId, await jsonBody(request)) });
    if (!resource && request.method === 'DELETE') { repositories.update(subject, projectId, { archived: true }); return sendJson(response, 200, { ok: true }); }
    if (resource === 'state' && request.method === 'GET') return sendJson(response, 200, { projectId, revision: found.project.revision, state: found.state }, { etag: `"${found.project.revision}"` });
    if (resource === 'state' && request.method === 'PUT') {
      const body = await jsonBody(request);
      const saved = repositories.save(subject, projectId, body.state || body, { baseRevision: body.baseRevision, force: body.force });
      if (saved.status === 409) return sendJson(response, 409, { error: 'Project changed since it was loaded.', revision: saved.revision, state: saved.state });
      if (saved.status === 422) return sendJson(response, 422, { error: saved.error, missingAttachments: saved.missingAttachments });
      if (saved.status === 404) return sendJson(response, 404, { error: 'Project not found.' });
      return sendJson(response, 200, saved, { etag: `"${saved.revision}"` });
    }
    if (resource === 'revisions' && !resourceId && request.method === 'GET') return sendJson(response, 200, { revisions: repositories.revisions(subject, projectId) });
    if (resource === 'revisions' && !resourceId && request.method === 'POST') {
      const body = await jsonBody(request);
      return sendJson(response, 201, { revision: repositories.checkpoint(subject, projectId, body.label) });
    }
    if (resource === 'revisions' && resourceId && request.method === 'GET') {
      const revision = repositories.revision(subject, projectId, resourceId);
      return revision ? sendJson(response, 200, revision) : sendJson(response, 404, { error: 'Revision not found.' });
    }
    if (resource === 'shares' && request.method === 'GET') return sendJson(response, 200, { shares: repositories.listShares(subject, projectId, BASE_URL) });
    if (resource === 'shares' && !resourceId && request.method === 'POST') {
      const body = await jsonBody(request);
      if (!['live', 'snapshot'].includes(body.mode)) return sendJson(response, 400, { error: 'Choose a live or snapshot share.' });
      if (body.expiresAt && (!Number.isFinite(new Date(body.expiresAt).getTime()) || new Date(body.expiresAt) <= new Date())) return sendJson(response, 400, { error: 'Share expiry must be a future date.' });
      return sendJson(response, 201, repositories.createShare(subject, projectId, body, BASE_URL));
    }
    if (resource === 'shares' && resourceId && request.method === 'DELETE') return repositories.revokeShare(subject, projectId, resourceId) ? sendJson(response, 200, { ok: true }) : sendJson(response, 404, { error: 'Share not found.' });
    if (resource === 'attachments' && !resourceId && request.method === 'POST') {
      const bytes = await readBody(request, MAX_ATTACHMENT);
      const result = repositories.putAttachment(subject, projectId, { name: url.searchParams.get('filename'), mime: request.headers['content-type'] || 'application/octet-stream', bytes });
      return result ? sendJson(response, 201, result) : sendJson(response, 404, { error: 'Project not found.' });
    }
    if (resource === 'attachments' && resourceId && request.method === 'DELETE') return repositories.deleteAttachment(subject, projectId, resourceId) ? sendJson(response, 200, { ok: true }) : sendJson(response, 404, { error: 'Attachment not found.' });
  }

  const current = repositories.current(subject);
  if (request.method === 'GET' && url.pathname === '/api/state') return sendJson(response, 200, { projectId: current.project.id, revision: current.project.revision, state: current.state });
  if (request.method === 'PUT' && url.pathname === '/api/state') {
    const body = await jsonBody(request);
    const saved = repositories.save(subject, current.project.id, body.state || body, { baseRevision: body.baseRevision, force: body.force });
    if (saved.status === 409) return sendJson(response, 409, { error: 'Project changed since it was loaded.', revision: saved.revision, state: saved.state });
    if (saved.status === 422) return sendJson(response, 422, { error: saved.error, missingAttachments: saved.missingAttachments });
    return sendJson(response, 200, saved);
  }
  if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname.startsWith('/attachments/')) {
    const record = repositories.attachment(subject, decodeURIComponent(url.pathname.slice('/attachments/'.length)));
    if (!record || !existsSync(record.storage_path)) return sendJson(response, 404, { error: 'Attachment not found.' });
    response.writeHead(200, securityHeaders({ 'content-type': record.mime, 'content-length': record.size, 'cache-control': 'private, no-store', etag: `"${record.sha256}"` }));
    if (request.method === 'HEAD') return response.end();
    return createReadStream(record.storage_path).pipe(response);
  }
  return sendJson(response, 404, { error: 'Not found.' });
}

function serveStatic(response, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const target = resolve(PUBLIC, requested);
  if (!target.startsWith(PUBLIC) || !existsSync(target) || !statSync(target).isFile()) return false;
  response.writeHead(200, securityHeaders({ 'content-type': contentTypes[extname(target).toLowerCase()] || 'application/octet-stream', 'cache-control': target.endsWith('index.html') ? 'no-store' : 'public, max-age=3600' }));
  createReadStream(target).pipe(response);
  return true;
}

const server = http.createServer(async (request, response) => {
  const started = Date.now();
  const requestId = crypto.randomUUID();
  try {
    const url = new URL(request.url || '/', BASE_URL);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/attachments/') || url.pathname === '/healthz' || url.pathname === '/readyz') await handleApi(request, response, url);
    else if (!serveStatic(response, url.pathname)) {
      const share = repositories.publicShare(decodeURIComponent(url.pathname.slice(1)));
      if (share) serveStatic(response, '/share.html');
      else if (!serveStatic(response, '/index.html')) sendJson(response, 404, { error: 'Application assets have not been built.' });
    }
  } catch (error) {
    if (!response.headersSent) sendJson(response, error.status || 500, { error: error.status ? error.message : 'Internal server error.', requestId });
    else response.destroy();
    console.error(JSON.stringify({ level: 'error', requestId, event: 'request_failed', status: error.status || 500, durationMs: Date.now() - started }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({ level: 'info', event: 'server_ready', address: `${HOST}:${PORT}`, dataDirectory: DATA_DIRECTORY }));
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { repositories.close(); process.exit(0); }));
