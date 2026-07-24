import http from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync, readdirSync, rmSync, statSync, createReadStream } from 'node:fs';
import { join, resolve, extname, basename, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const PROJECTS = join(ROOT, 'projects');
const PORT = Number(process.env.PORT || 4317);
const HOST = '127.0.0.1';
const CONFIG_DIR = platform() === 'win32'
  ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'IdeationWorkbench')
  : join(homedir(), '.config', 'ideation-workbench');
const CONFIG_FILE = join(CONFIG_DIR, 'settings.json');
const MAX_BODY = 15 * 1024 * 1024;
const AUTO_BACKUP_MS = 5 * 60 * 1000;
const MAX_BACKUPS = 20;

let projectPath = null;
let db = null;
let lastBackupAt = 0;

function now() { return new Date().toISOString(); }
function safeJson(text, fallback = null) { try { return JSON.parse(text); } catch { return fallback; } }
function readConfig() { return existsSync(CONFIG_FILE) ? safeJson(readFileSync(CONFIG_FILE, 'utf8'), {}) : {}; }
function writeConfig(value) { mkdirSync(CONFIG_DIR, { recursive: true }); writeFileSync(CONFIG_FILE, JSON.stringify(value, null, 2)); }

function defaultState(projectName = 'My Ideation Project') {
  const themeId = randomUUID();
  const stamp = now();
  return {
    version: 1,
    meta: { id: randomUUID(), name: projectName, createdAt: stamp, updatedAt: stamp },
    themes: [{ id: themeId, name: 'Core', parentId: null, hiddenInheritedImplementationIds: [], hiddenInheritedConflictIds: [] }],
    ideaGroups: [],
    implementationGroups: [],
    ideas: [],
    implementations: [],
    groupLinks: [],
    conflicts: [],
    savedViews: [],
    uiByTheme: {
      [themeId]: {
        lockedImplementationIds: [],
        visibleImplementationIds: [],
        previousVisibleImplementationIds: [],
        expandedIdeaIds: [],
        expandedImplementationIds: [],
        showExcluded: true,
        search: '',
        ideaGroupFilter: 'all'
      }
    },
    activeThemeId: themeId
  };
}

function ensureProjectFolders(path) {
  mkdirSync(path, { recursive: true });
  mkdirSync(join(path, 'attachments'), { recursive: true });
  mkdirSync(join(path, 'backups'), { recursive: true });
}

function openProject(path, projectName) {
  const absolute = resolve(path);
  ensureProjectFolders(absolute);
  if (db) db.close();
  projectPath = absolute;
  db = new DatabaseSync(join(projectPath, 'project.sqlite'));
  db.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS project_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const row = db.prepare('SELECT json FROM project_state WHERE id = 1').get();
  if (!row) {
    const state = defaultState(projectName || basename(absolute));
    db.prepare('INSERT INTO project_state (id, json, updated_at) VALUES (1, ?, ?)').run(JSON.stringify(state), now());
  }
  const config = readConfig();
  writeConfig({ ...config, lastProjectPath: absolute });
  return loadState();
}

function loadState() {
  if (!db) throw new Error('No project is open.');
  const row = db.prepare('SELECT json FROM project_state WHERE id = 1').get();
  if (!row) throw new Error('Project database is missing its state.');
  return JSON.parse(row.json);
}

function saveState(state) {
  if (!db) throw new Error('No project is open.');
  if (!state || typeof state !== 'object') throw new Error('Invalid project state.');
  state.meta = state.meta || {};
  state.meta.updatedAt = now();
  db.prepare('UPDATE project_state SET json = ?, updated_at = ? WHERE id = 1').run(JSON.stringify(state), state.meta.updatedAt);
  if (Date.now() - lastBackupAt >= AUTO_BACKUP_MS) createBackup(false);
  return state;
}

function createBackup(force = true) {
  if (!db || !projectPath) throw new Error('No project is open.');
  if (!force && Date.now() - lastBackupAt < AUTO_BACKUP_MS) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(projectPath, 'backups', stamp);
  mkdirSync(target, { recursive: true });
  copyFileSync(join(projectPath, 'project.sqlite'), join(target, 'project.sqlite'));
  const sourceAttachments = join(projectPath, 'attachments');
  const targetAttachments = join(target, 'attachments');
  mkdirSync(targetAttachments, { recursive: true });
  for (const entry of readdirSync(sourceAttachments, { withFileTypes: true })) {
    if (entry.isFile()) copyFileSync(join(sourceAttachments, entry.name), join(targetAttachments, entry.name));
  }
  writeFileSync(join(target, 'backup.json'), JSON.stringify({ createdAt: now(), projectPath }, null, 2));
  const backupsRoot = join(projectPath, 'backups');
  const backups = readdirSync(backupsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: join(backupsRoot, entry.name), mtime: statSync(join(backupsRoot, entry.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const old of backups.slice(MAX_BACKUPS)) rmSync(old.path, { recursive: true, force: true });
  lastBackupAt = Date.now();
  return target;
}

function contentType(path) {
  return ({
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8'
  })[extname(path).toLowerCase()] || 'application/octet-stream';
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendError(res, status, message) { sendJson(res, status, { error: message }); }

function readBody(req, max = MAX_BODY) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > max) { rejectBody(new Error('Request is too large.')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', rejectBody);
  });
}

const PICKER_PROMPT = 'Choose or create an Ideation Workbench project folder';
let pickerActive = false;

function runDialog(executable, args, { cancelMarkers = [], cancelCodes = [], windowsHide = true } = {}) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { encoding: 'utf8', timeout: 5 * 60 * 1000, windowsHide }, (error, stdout) => {
      if (error) {
        if (error.code === 'ENOENT') {
          const enoent = new Error(`'${executable}' is not available on this system.`);
          enoent.code = 'ENOENT';
          return reject(enoent);
        }
        const text = String(error.message || '').trim();
        const status = error.status === undefined ? NaN : error.status;
        const canceled = cancelCodes.includes(status) || cancelMarkers.some((marker) => text.toLowerCase().includes(marker.toLowerCase()));
        if (canceled) return resolve('');
        return reject(new Error(text || 'The folder picker failed to open.'));
      }
      resolve(String(stdout || '').trim());
    });
  });
}

function chooseFolderWindows(startPath) {
  const escapedStart = String(startPath || '').replace(/'/g, "''");
  const script = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class IwPick {
  public delegate bool EnumCb(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCb cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentProcessId();
}
"@
[System.Windows.Forms.Application]::EnableVisualStyles()
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Ideation Workbench'
$form.ShowInTaskbar = $false
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(-32000, -32000)
$form.Size = New-Object System.Drawing.Size(0, 0)
$form.TopMost = $true
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose or create an Ideation Workbench project folder'
$dialog.ShowNewFolderButton = $true
$startFolder = '${escapedStart}'
if ($startFolder -and (Test-Path $startFolder)) { $dialog.SelectedPath = $startFolder }
$procId = [IwPick]::GetCurrentProcessId()
$topMost = [IntPtr]::new(-1)
$script:found = [IntPtr]::Zero
$script:tries = 0
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 80
$timer.Add_Tick({
  try {
    $script:tries = $script:tries + 1
    if ($script:found -eq [IntPtr]::Zero) {
      $cb = [IwPick+EnumCb] {
        param($h, $l)
        $ownerPid = 0
        [void][IwPick]::GetWindowThreadProcessId($h, [ref]$ownerPid)
        if ($ownerPid -eq $procId) {
          $name = New-Object System.Text.StringBuilder 32
          [void][IwPick]::GetClassName($h, $name, 32)
          if ([IwPick]::IsWindowVisible($h) -and $name.ToString() -eq '#32770') { $script:found = $h }
        }
        return $true
      }
      [void][IwPick]::EnumWindows($cb, [IntPtr]::Zero)
    }
    if ($script:found -ne [IntPtr]::Zero) {
      [void][IwPick]::SetWindowPos($script:found, $topMost, 0, 0, 0, 0, 0x0013)
      [void][IwPick]::BringWindowToTop($script:found)
      $timer.Stop()
    } elseif ($script:tries -gt 75) { $timer.Stop() }
  } catch { $timer.Stop() }
})
$timer.Start()
$result = $dialog.ShowDialog($form)
$timer.Stop()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }
$dialog.Dispose()
$form.Close()
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const bundledPowerShell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const executable = existsSync(bundledPowerShell) ? bundledPowerShell : 'powershell.exe';
  return runDialog(executable, ['-WindowStyle', 'Hidden', '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-EncodedCommand', encoded], { windowsHide: false });
}

function chooseFolderMac(startPath) {
  const location = startPath && existsSync(startPath) ? ` default location (POSIX file "${startPath.replace(/"/g, '\\"')}" as alias)` : '';
  return runDialog('osascript', ['-e', `POSIX path of (choose folder with prompt "${PICKER_PROMPT}"${location})`], {
    cancelMarkers: ['user canceled', 'user cancelled', 'operation was canceled', '(-128)'],
    cancelCodes: [1],
  });
}

async function chooseFolderLinux(startPath) {
  const initial = (startPath && existsSync(startPath)) ? startPath : homedir();
  try {
    return await runDialog('zenity', ['--file-selection', '--directory', `--filename=${initial}/`, `--title=${PICKER_PROMPT}`], { cancelCodes: [1] });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return runDialog('kdialog', ['--getexistingdirectory', initial, PICKER_PROMPT], { cancelCodes: [1] });
}

function chooseFolder(startPath) {
  const current = platform();
  if (current === 'win32') return chooseFolderWindows(startPath);
  if (current === 'darwin') return chooseFolderMac(startPath);
  if (current === 'linux') return chooseFolderLinux(startPath);
  return Promise.reject(new Error('Native folder picking is not supported on this operating system. Enter a folder path manually.'));
}

function defaultPickerStartPath() {
  const last = readConfig().lastProjectPath;
  if (last) {
    const parent = dirname(last);
    if (existsSync(parent)) return parent;
    if (existsSync(last)) return last;
  }
  const docs = join(homedir(), 'Documents');
  return existsSync(docs) ? docs : homedir();
}

function bundledProjects() {
  if (!existsSync(PROJECTS)) return [];
  return readdirSync(PROJECTS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(PROJECTS, entry.name, 'project.sqlite')))
    .map((entry) => {
      const path = join(PROJECTS, entry.name);
      let name = entry.name;
      const manifestPath = join(path, 'content-manifest.json');
      if (existsSync(manifestPath)) {
        const manifest = safeJson(readFileSync(manifestPath, 'utf8'), {});
        name = manifest?.project?.name || name;
      }
      return { id: entry.name, name, path, relativePath: `projects/${entry.name}` };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function attachmentPath(storageName) {
  if (!projectPath) throw new Error('No project is open.');
  const safe = basename(storageName);
  return join(projectPath, 'attachments', safe);
}

async function handleApi(req, res, url) {
  try {
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return sendJson(res, 200, { open: Boolean(db), path: projectPath, state: db ? loadState() : null });
    }
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      return sendJson(res, 200, { projects: bundledProjects() });
    }
    if (req.method === 'POST' && url.pathname === '/api/project/pick') {
      if (pickerActive) return sendError(res, 409, 'A folder picker is already open. Check your taskbar or other windows.');
      pickerActive = true;
      try {
        const started = Date.now();
        const startAt = defaultPickerStartPath();
        console.log(`[picker] launching native folder picker (start: ${startAt})…`);
        const path = await chooseFolder(startAt);
        console.log(`[picker] closed after ${Date.now() - started}ms → ${path ? path : '(cancelled)'}`);
        return sendJson(res, 200, { path });
      } catch (error) {
        console.error('[picker] failed:', error.message);
        return sendError(res, 500, error.message);
      } finally {
        pickerActive = false;
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/project/open') {
      const body = safeJson((await readBody(req)).toString('utf8'), {});
      if (!body.path || typeof body.path !== 'string') return sendError(res, 400, 'A project folder path is required.');
      const state = openProject(body.path, body.name);
      return sendJson(res, 200, { path: projectPath, state });
    }
    if (req.method === 'POST' && url.pathname === '/api/project/close') {
      if (db) db.close();
      db = null; projectPath = null;
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return sendJson(res, 200, loadState());
    if (req.method === 'PUT' && url.pathname === '/api/state') {
      const state = safeJson((await readBody(req)).toString('utf8'));
      if (!state) return sendError(res, 400, 'Invalid JSON.');
      return sendJson(res, 200, saveState(state));
    }
    if (req.method === 'POST' && url.pathname === '/api/backup') {
      const target = createBackup(true);
      return sendJson(res, 200, { ok: true, target });
    }
    if (req.method === 'POST' && url.pathname === '/api/attachments') {
      if (!projectPath) return sendError(res, 409, 'Open a project first.');
      const filename = decodeURIComponent(url.searchParams.get('filename') || 'attachment.bin');
      const mime = req.headers['content-type'] || 'application/octet-stream';
      const body = await readBody(req, 100 * 1024 * 1024);
      const id = randomUUID();
      const storageName = `${id}-${basename(filename).replace(/[^a-zA-Z0-9._ -]/g, '_')}`;
      writeFileSync(attachmentPath(storageName), body);
      return sendJson(res, 201, { id, name: basename(filename), storageName, mime, size: body.length, url: `/attachments/${encodeURIComponent(storageName)}` });
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/attachments/')) {
      const storageName = decodeURIComponent(url.pathname.slice('/api/attachments/'.length));
      rmSync(attachmentPath(storageName), { force: true });
      return sendJson(res, 200, { ok: true });
    }
    return sendError(res, 404, 'Not found.');
  } catch (error) {
    console.error(error);
    return sendError(res, 500, error instanceof Error ? error.message : String(error));
  }
}

function serveFile(res, path) {
  if (!existsSync(path) || !statSync(path).isFile()) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': contentType(path), 'Cache-Control': path.endsWith('index.html') ? 'no-store' : 'no-cache' });
  createReadStream(path).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  if (url.pathname.startsWith('/attachments/')) {
    if (!projectPath) { res.writeHead(404); res.end('No project'); return; }
    return serveFile(res, attachmentPath(decodeURIComponent(url.pathname.slice('/attachments/'.length))));
  }
  const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const target = resolve(PUBLIC, requested);
  if (!target.startsWith(PUBLIC)) { res.writeHead(403); res.end('Forbidden'); return; }
  if (existsSync(target) && statSync(target).isFile()) return serveFile(res, target);
  return serveFile(res, join(PUBLIC, 'index.html'));
});

function tryOpenLastProject() {
  const config = readConfig();
  if (config.lastProjectPath && existsSync(config.lastProjectPath)) {
    try { openProject(config.lastProjectPath); } catch (error) { console.warn('Could not reopen last project:', error.message); }
  }
}

function openBrowser() {
  if (process.env.NO_OPEN === '1') return;
  const target = `http://${HOST}:${PORT}`;
  if (platform() === 'win32') spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore' }).unref();
  else if (platform() === 'darwin') spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
}

tryOpenLastProject();
server.listen(PORT, HOST, () => {
  console.log(`Ideation Workbench running at http://${HOST}:${PORT}`);
  console.log(projectPath ? `Project: ${projectPath}` : 'No project is open yet.');
  openBrowser();
});

process.on('SIGINT', () => { if (db) db.close(); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { if (db) db.close(); server.close(() => process.exit(0)); });
