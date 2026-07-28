import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeRepositories, defaultState } from './node-repositories.mjs';

test('Node repository enforces identity isolation and optimistic revisions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ideation-workbench-'));
  let repositories;
  try {
    repositories = new NodeRepositories(directory);
    const created = repositories.create('owner-a', defaultState('First'));
    assert.equal(repositories.list('owner-a').length, 1);
    assert.equal(repositories.get('owner-b', created.project.id), null);
    const next = structuredClone(created.state); next.meta.name = 'Changed';
    const saved = repositories.save('owner-a', created.project.id, next, { baseRevision: 1 });
    assert.equal(saved.revision, 2);
    const conflict = repositories.save('owner-a', created.project.id, next, { baseRevision: 1 });
    assert.equal(conflict.status, 409);
    const checkpoint = repositories.checkpoint('owner-a', created.project.id, 'Approved direction');
    assert.equal(checkpoint.label, 'Approved direction');
    assert.equal(repositories.revision('owner-a', created.project.id, checkpoint.id).state.meta.name, 'Changed');
    assert.equal(repositories.revisions('owner-a', created.project.id).length, 2);
  } finally {
    repositories?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Node repository stores attachments and revokes public shares', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ideation-workbench-'));
  let repositories;
  try {
    repositories = new NodeRepositories(directory);
    const created = repositories.create('owner', defaultState('Files'));
    const attachment = repositories.putAttachment('owner', created.project.id, { name: 'note.txt', mime: 'text/plain', bytes: Buffer.from('hello') });
    assert.equal(attachment.size, 5);
    const share = repositories.createShare('owner', created.project.id, { mode: 'snapshot' }, 'https://example.test');
    assert.equal(repositories.publicShare(share.slug).mode, 'snapshot');
    assert.equal(repositories.revokeShare('owner', created.project.id, share.id), true);
    assert.equal(repositories.publicShare(share.slug), null);
    assert.equal(repositories.deleteAttachment('owner', created.project.id, attachment.id), true);
  } finally {
    repositories?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
