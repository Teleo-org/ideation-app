import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProjectDocument, projectDocument } from '../public/portable.mjs';

const state = { meta: { id: 'project-1', name: 'Portable project' }, ideas: [], implementations: [] };

test('portable project document round-trips the project state', () => {
  const document = projectDocument(state);
  assert.equal(document.format, 'ideation-workbench/project-directory');
  assert.deepEqual(parseProjectDocument(JSON.stringify(document)), state);
});

test('portable parser rejects unknown document formats', () => {
  assert.throws(() => parseProjectDocument(JSON.stringify({ format: 'other', version: 1, state })), /not a supported/);
});
