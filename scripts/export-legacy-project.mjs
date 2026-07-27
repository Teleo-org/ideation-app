import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('Usage: node scripts/export-legacy-project.mjs <project.sqlite> <ideation-project.json>');
  process.exit(1);
}

const database = new DatabaseSync(resolve(input), { readOnly: true });
const row = database.prepare('SELECT json FROM project_state WHERE id = 1').get();
database.close();
if (!row?.json) throw new Error('The SQLite project does not contain project_state id 1.');

const state = JSON.parse(row.json);
const document = {
  format: 'ideation-workbench/project-directory',
  version: 1,
  exportedAt: new Date().toISOString(),
  state,
};
const target = resolve(output);
await mkdir(dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(`Exported ${state.meta?.name || 'project'} to ${target}`);
