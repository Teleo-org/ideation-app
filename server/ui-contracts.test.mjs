import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('main board exposes sort before search and a dedicated display settings gear', () => {
  const sortIndex = index.indexOf('id="idea-sort"');
  const searchIndex = index.indexOf('id="search-input"');
  const restoreIndex = index.indexOf('data-action="restore-visible"');
  const settingsIndex = index.indexOf('data-action="open-display-settings"', restoreIndex);
  assert.ok(sortIndex >= 0 && sortIndex < searchIndex, 'sort control precedes search');
  assert.ok(settingsIndex > restoreIndex, 'display settings gear follows Restore previous');
  assert.match(app, /#idea-sort'\)\.addEventListener\('change'/);
  assert.match(app, /action === 'toggle-idea-sort-direction'/);
  assert.match(app, /data-mobile-idea-sort/);
});

test('create relationship flow uses the same picker with an empty, open list', () => {
  assert.match(app, /data-action="open-empty-relationship-flow"/);
  assert.match(app, /action === 'open-empty-relationship-flow'.*openRelationshipFlow\(true\)/);
  assert.match(app, /function openRelationshipFlow\(allowEmpty = false\)/);
  assert.match(app, /if \(!top\.length\) return.*relationship-options/);
});
