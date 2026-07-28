import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProjectDocument, projectDocument } from '../public/portable.mjs';

const state = {
  version: 2,
  meta: { id: 'project-1', name: 'Portable project', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  themes: [{ id: 'theme-1', name: 'Core', parentId: null }],
  activeThemeId: 'theme-1',
  ideas: [],
  implementations: [],
  ideaGroups: [],
  implementationGroups: [],
  groupLinks: [],
  conflicts: [],
  requirements: [],
  savedViews: [],
  uiByTheme: { 'theme-1': {} },
};

test('portable project document round-trips and upgrades the project state', () => {
  const document = projectDocument(state);
  assert.equal(document.format, 'ideation-workbench/project-directory');
  const parsed = parseProjectDocument(JSON.stringify(document));
  assert.equal(parsed.version, 2);
  assert.equal(parsed.meta.name, state.meta.name);
  assert.equal(parsed.activeThemeId, 'theme-1');
});

test('portable parser rejects unknown document formats', () => {
  assert.throws(() => parseProjectDocument(JSON.stringify({ format: 'other', version: 1, state })), /not a supported/);
});
