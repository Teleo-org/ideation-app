import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { dirname, resolve, join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { validateProjectDocument } from '../src/shared/project-document.mjs';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('Usage: node scripts/export-legacy-project.mjs <project.sqlite> <project.zip>');
  process.exit(1);
}

const sourceDatabase = resolve(input);
const projectDirectory = dirname(sourceDatabase);
const database = new DatabaseSync(sourceDatabase, { readOnly: true });
const row = database.prepare('SELECT json FROM project_state WHERE id = 1').get();
database.close();
if (!row?.json) throw new Error('The SQLite project does not contain project_state id 1.');

const state = validateProjectDocument(JSON.parse(row.json));
const files = { 'project.json': strToU8(JSON.stringify(state, null, 2)) };
const attachments = [];
const attachmentDirectory = join(projectDirectory, 'attachments');
const available = new Map();
try {
  for (const name of await readdir(attachmentDirectory)) available.set(name, join(attachmentDirectory, name));
} catch {}

for (const implementation of state.implementations) {
  for (const reference of implementation.attachments || []) {
    const storageName = reference.storageName || basename(String(reference.url || ''));
    const source = available.get(storageName);
    if (!source) throw new Error(`Legacy attachment is missing: ${reference.name || storageName}`);
    const bytes = await readFile(source);
    const path = `attachments/${storageName.replace(/[^a-zA-Z0-9._ -]/g, '_')}`;
    files[path] = bytes;
    attachments.push({ id: reference.id || storageName, name: reference.name || storageName, mime: reference.mime || 'application/octet-stream', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), path });
  }
}

files['manifest.json'] = strToU8(JSON.stringify({ format: 'ideation-workbench/archive', version: 2, exportedAt: new Date().toISOString(), projectFile: 'project.json', attachments }, null, 2));
const target = resolve(output);
await mkdir(dirname(target), { recursive: true });
await writeFile(target, zipSync(files, { level: 6 }));
console.log(`Exported ${state.meta?.name || 'project'} with ${attachments.length} attachment(s) to ${target}`);
