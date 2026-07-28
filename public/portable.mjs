import { strToU8, zipSync, unzipSync, strFromU8 } from 'fflate';
import { validateProjectDocument, projectDocumentForPersistence } from '../src/shared/project-document.mjs';

const FORMAT_V1 = 'ideation-workbench/project-directory';
const FORMAT_V2 = 'ideation-workbench/archive';
const importedFiles = new WeakMap();

function filename(name) {
  return String(name || 'ideation-project').replace(/[^a-zA-Z0-9 _-]/g, '_').trim() || 'ideation-project';
}

function attachmentName(attachment) {
  const id = String(attachment.id || attachment.storageName || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '_');
  const name = String(attachment.name || 'attachment.bin').replace(/[^a-zA-Z0-9._ -]/g, '_');
  return `attachments/${id}-${name}`;
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function attachmentRefs(state) {
  const refs = new Map();
  for (const implementation of state.implementations || []) {
    for (const attachment of implementation.attachments || []) {
      const key = attachment.id || attachment.storageName || attachment.url;
      if (key && !refs.has(key)) refs.set(key, attachment);
    }
  }
  return [...refs.values()];
}

export function projectDocument(state) {
  return { format: FORMAT_V1, version: 1, exportedAt: new Date().toISOString(), state: projectDocumentForPersistence(state) };
}

export function parseProjectDocument(text) {
  const document = JSON.parse(text);
  if (document?.format === FORMAT_V1 && document.version === 1 && document.state?.meta) return validateProjectDocument(document.state);
  if (document?.format === FORMAT_V2 && document.version === 2 && document.project?.meta) return validateProjectDocument(document.project);
  throw new Error('This is not a supported Ideation project export.');
}

async function createArchive(state) {
  const project = projectDocumentForPersistence(state);
  const files = {};
  const manifestAttachments = [];
  for (const attachment of attachmentRefs(project)) {
    if (!attachment.url) throw new Error(`Attachment "${attachment.name || 'Untitled'}" cannot be read for export.`);
    const response = await fetch(attachment.url);
    if (!response.ok) throw new Error(`Attachment "${attachment.name || 'Untitled'}" could not be exported.`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const path = attachmentName(attachment);
    files[path] = bytes;
    manifestAttachments.push({
      id: attachment.id || attachment.storageName,
      name: attachment.name || 'attachment.bin',
      mime: attachment.mime || response.headers.get('content-type') || 'application/octet-stream',
      size: bytes.byteLength,
      sha256: await sha256(bytes),
      path,
    });
  }
  const manifest = {
    format: FORMAT_V2,
    version: 2,
    exportedAt: new Date().toISOString(),
    projectFile: 'project.json',
    attachments: manifestAttachments,
  };
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  files['project.json'] = strToU8(JSON.stringify(project, null, 2));
  return files;
}

export async function downloadProjectZip(state) {
  const archive = zipSync(await createArchive(state), { level: 6 });
  const blob = new Blob([archive], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${filename(state.meta?.name)}.zip`;
  link.click();
  URL.revokeObjectURL(url);
}

export async function exportProjectDirectory(state) {
  if (!window.showDirectoryPicker) throw new Error('Directory export is supported in Chromium-based browsers. Use ZIP export in this browser.');
  const root = await window.showDirectoryPicker({ mode: 'readwrite' });
  const files = await createArchive(state);
  for (const [path, bytes] of Object.entries(files)) {
    const parts = path.split('/');
    let directory = root;
    while (parts.length > 1) directory = await directory.getDirectoryHandle(parts.shift(), { create: true });
    const handle = await directory.getFileHandle(parts[0], { create: true });
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
  }
}

async function parseArchive(files) {
  const manifestBytes = files['manifest.json'];
  if (!manifestBytes) {
    const legacy = files['ideation-project.json'];
    if (!legacy) throw new Error('The ZIP does not contain a supported project archive.');
    return parseProjectDocument(strFromU8(legacy));
  }
  const manifest = JSON.parse(strFromU8(manifestBytes));
  if (manifest.format !== FORMAT_V2 || manifest.version !== 2) throw new Error('This archive version is not supported.');
  const projectBytes = files[manifest.projectFile || 'project.json'];
  if (!projectBytes) throw new Error('The archive is missing project.json.');
  const state = validateProjectDocument(JSON.parse(strFromU8(projectBytes)));
  const attachments = [];
  for (const entry of manifest.attachments || []) {
    const bytes = files[entry.path];
    if (!bytes) throw new Error(`The archive is missing ${entry.path}.`);
    if (bytes.byteLength !== entry.size || await sha256(bytes) !== entry.sha256) throw new Error(`Attachment checksum failed for ${entry.name}.`);
    attachments.push({ ...entry, blob: new Blob([bytes], { type: entry.mime || 'application/octet-stream' }) });
  }
  importedFiles.set(state, attachments);
  return state;
}

export function importedAttachments(state) {
  return importedFiles.get(state) || [];
}

export async function importProjectFile(file) {
  if (file.name.toLowerCase().endsWith('.zip')) return parseArchive(unzipSync(new Uint8Array(await file.arrayBuffer())));
  return parseProjectDocument(await file.text());
}

export async function importProjectDirectory() {
  if (!window.showDirectoryPicker) throw new Error('Directory import is supported in Chromium-based browsers. Import a ZIP in this browser.');
  const root = await window.showDirectoryPicker({ mode: 'read' });
  try {
    const manifestHandle = await root.getFileHandle('manifest.json');
    const manifest = JSON.parse(await (await manifestHandle.getFile()).text());
    const projectHandle = await root.getFileHandle(manifest.projectFile || 'project.json');
    const state = validateProjectDocument(JSON.parse(await (await projectHandle.getFile()).text()));
    const attachmentsDirectory = await root.getDirectoryHandle('attachments');
    const attachments = [];
    for (const entry of manifest.attachments || []) {
      const handle = await attachmentsDirectory.getFileHandle(entry.path.split('/').pop());
      const file = await handle.getFile();
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.byteLength !== entry.size || await sha256(bytes) !== entry.sha256) throw new Error(`Attachment checksum failed for ${entry.name}.`);
      attachments.push({ ...entry, blob: file });
    }
    importedFiles.set(state, attachments);
    return state;
  } catch (error) {
    if (error?.name !== 'NotFoundError') throw error;
    const handle = await root.getFileHandle('ideation-project.json');
    return parseProjectDocument(await (await handle.getFile()).text());
  }
}
