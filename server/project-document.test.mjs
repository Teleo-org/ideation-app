import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProjectDocument, ProjectValidationError } from '../src/shared/project-document.mjs';

function validState() {
  return {
    version: 1,
    meta: { id: 'p1', name: 'Project', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    themes: [{ id: 't1', name: 'Core', parentId: null }],
    activeThemeId: 't1',
    ideas: [{ id: 'i1', title: 'Idea', groupIds: [] }],
    implementations: [{ id: 'm1', title: 'Method', ideaIds: ['i1'], themeIds: ['t1'], groupIds: [] }, { id: 'm2', title: 'Other', ideaIds: ['i1'], themeIds: ['t1'], groupIds: [] }],
    ideaGroups: [], implementationGroups: [], groupLinks: [],
    conflicts: [{ id: 'c1', name: 'Conflict', implementationIds: ['m1', 'm2'], themeId: null }],
    requirements: [{ id: 'r1', fromImplementationId: 'm1', toImplementationId: 'm2' }],
    savedViews: [], uiByTheme: { t1: {} },
  };
}

test('V1 project documents migrate to validated V2 documents', () => {
  const state = validateProjectDocument(validState());
  assert.equal(state.version, 2);
  assert.deepEqual(state.uiByTheme.t1.ideaGroupFilterIds, []);
});

test('display settings and idea sorting persist with safe bounds', () => {
  const state = validState();
  state.displaySettings = { ideaTitleSize: 40, ideaDetailsSize: 8, implementationTitleSize: 17, implementationDetailsSize: 15 };
  state.uiByTheme.t1 = { ideaSort: 'conflicts', ideaSortDirection: 'desc' };
  const normalized = validateProjectDocument(state);
  assert.deepEqual(normalized.displaySettings, { ideaTitleSize: 32, ideaDetailsSize: 10, implementationTitleSize: 17, implementationDetailsSize: 15 });
  assert.equal(normalized.uiByTheme.t1.ideaSort, 'conflicts');
  assert.equal(normalized.uiByTheme.t1.ideaSortDirection, 'desc');
});

test('validation rejects dangling references and theme cycles', () => {
  const state = validState();
  state.implementations[0].ideaIds = ['missing'];
  state.themes.push({ id: 't2', name: 'Child', parentId: 't3' }, { id: 't3', name: 'Cycle', parentId: 't2' });
  assert.throws(() => validateProjectDocument(state), (error) => error instanceof ProjectValidationError && error.issues.some((issue) => issue.includes('missing idea')) && error.issues.some((issue) => issue.includes('parent cycle')));
});

test('validation rejects self requirements and incomplete conflicts', () => {
  const state = validState();
  state.requirements[0].toImplementationId = 'm1';
  state.conflicts[0].implementationIds = ['m1'];
  assert.throws(() => validateProjectDocument(state), /at least two implementations/);
});
