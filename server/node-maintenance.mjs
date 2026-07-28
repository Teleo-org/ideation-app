import { existsSync, mkdirSync, copyFileSync, cpSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { NodeRepositories } from './node-repositories.mjs';

const [command, requestedPath] = process.argv.slice(2);
const dataDirectory = resolve(process.env.IW_DATA_DIR || '.data');
const target = requestedPath ? resolve(requestedPath) : null;

if (!['backup', 'restore'].includes(command) || !target) {
  console.error('Usage: node server/node-maintenance.mjs <backup|restore> <directory>');
  process.exit(2);
}

if (target === dataDirectory || target === dirname(target)) {
  console.error('The backup directory must be distinct from the data directory and filesystem root.');
  process.exit(2);
}

if (command === 'backup') {
  const repositories = new NodeRepositories(dataDirectory);
  try { repositories.backup(target); }
  finally { repositories.close(); }
  console.log(`Backup written to ${target}`);
} else {
  const database = join(target, 'ideation-workbench.sqlite');
  if (!existsSync(database)) {
    console.error(`Backup database not found at ${database}`);
    process.exit(2);
  }
  mkdirSync(dataDirectory, { recursive: true });
  copyFileSync(database, join(dataDirectory, 'ideation-workbench.sqlite'));
  const attachmentBackup = join(target, 'attachments');
  const attachmentTarget = join(dataDirectory, 'attachments');
  rmSync(attachmentTarget, { recursive: true, force: true });
  if (existsSync(attachmentBackup)) cpSync(attachmentBackup, attachmentTarget, { recursive: true, force: true });
  else mkdirSync(attachmentTarget, { recursive: true });
  console.log(`Backup restored into ${dataDirectory}. Start the service and verify /readyz.`);
}
