import { strToU8, zipSync, unzipSync, strFromU8 } from 'fflate';

const FORMAT = 'ideation-workbench/project-directory';
const VERSION = 1;

function filename(name) { return String(name || 'ideation-project').replace(/[^a-zA-Z0-9 _-]/g, '_').trim() || 'ideation-project'; }

export function projectDocument(state) {
  return { format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), state };
}

export function parseProjectDocument(text) {
  const document = JSON.parse(text);
  if (document?.format !== FORMAT || document.version !== VERSION || !document.state?.meta) throw new Error('This is not a supported Ideation project export.');
  return document.state;
}

export function downloadProjectZip(state) {
  const archive = zipSync({ 'ideation-project.json': strToU8(JSON.stringify(projectDocument(state), null, 2)) }, { level: 6 });
  const blob = new Blob([archive], { type: 'application/zip' }); const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = url; link.download = `${filename(state.meta?.name)}.zip`; link.click(); URL.revokeObjectURL(url);
}

export async function exportProjectDirectory(state) {
  if (!window.showDirectoryPicker) throw new Error('Directory export is supported in Chromium-based browsers. Use ZIP export in this browser.');
  const root = await window.showDirectoryPicker({ mode: 'readwrite' });
  const handle = await root.getFileHandle('ideation-project.json', { create: true });
  const writable = await handle.createWritable(); await writable.write(JSON.stringify(projectDocument(state), null, 2)); await writable.close();
}

export async function importProjectFile(file) {
  if (file.name.toLowerCase().endsWith('.zip')) {
    const files = unzipSync(new Uint8Array(await file.arrayBuffer())); const data = files['ideation-project.json'];
    if (!data) throw new Error('The ZIP does not contain ideation-project.json.'); return parseProjectDocument(strFromU8(data));
  }
  return parseProjectDocument(await file.text());
}

export async function importProjectDirectory() {
  if (!window.showDirectoryPicker) throw new Error('Directory import is supported in Chromium-based browsers. Import a ZIP in this browser.');
  const root = await window.showDirectoryPicker({ mode: 'read' });
  const handle = await root.getFileHandle('ideation-project.json');
  return parseProjectDocument(await (await handle.getFile()).text());
}
