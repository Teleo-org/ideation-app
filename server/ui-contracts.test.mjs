import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const shared = readFileSync(new URL('../public/share.js', import.meta.url), 'utf8');
const controls = readFileSync(new URL('../public/board-controls.mjs', import.meta.url), 'utf8');

test('main board exposes shared sort controls and a dedicated display settings gear', () => {
  const sortIndex = controls.indexOf('idea-sort');
  const searchIndex = controls.indexOf('search');
  const restoreIndex = index.indexOf('data-action="restore-visible"');
  const settingsIndex = index.indexOf('data-action="open-display-settings"', restoreIndex);
  assert.ok(sortIndex >= 0 && searchIndex >= 0, 'shared controls include search and sort');
  assert.ok(settingsIndex > restoreIndex, 'display settings gear follows Restore previous');
  assert.match(app, /event\.target\.id === 'idea-sort'/);
  assert.match(app, /action === 'toggle-idea-sort-direction'/);
  assert.match(app, /data-mobile-idea-sort/);
});

test('create relationship flow uses the same picker with an empty, open list', () => {
  assert.match(app, /data-action="open-empty-relationship-flow"/);
  assert.match(app, /action === 'open-empty-relationship-flow'.*openRelationshipFlow\(true\)/);
  assert.match(app, /function openRelationshipFlow\(allowEmpty = false\)/);
  assert.match(app, /if \(!top\.length\) return.*relationship-options/);
});

test('shared and private boards use the same board controls component', () => {
  assert.match(index, /<section id="board-controls" class="filterbar">/);
  assert.match(app, /from '\.\/board-controls\.mjs'/);
  assert.match(shared, /from '\.\/board-controls\.mjs'/);
  assert.match(shared, /boardControlsHtml\(\{ view: localView, groups: project\.ideaGroups \|\| \[\], shared: true \}\)/);
  assert.match(shared, /shared-idea-sort/);
});

test('Clerk bootstrap has a visible loading state, timeout, retry, and first-party loader', () => {
  assert.match(app, /let clerkStatus = 'idle'/);
  assert.match(app, /clerkStatus === 'loading'/);
  assert.match(app, /loading-spinner/);
  assert.match(app, /Clerk took too long to initialize/);
  assert.match(app, /clerk\.teleoflexuous\.com\/npm\/@clerk\/clerk-js/);
  assert.match(app, /clerkStatus === 'error'/);
  assert.match(app, /Retrying sign-in/);
  assert.match(app, /try \{\s*await continueAsGuest\(\);\s*await initializeClerk\(\);/);
});

test('private client shell contains every startup control host used by app bootstrap', () => {
  for (const id of ['app', 'account-button', 'board-controls', 'board', 'inspector', 'modal', 'modal-title', 'modal-body', 'toast']) {
    assert.match(index, new RegExp(`id="${id}"`), `#${id} is present in the initial document`);
  }
  assert.match(app, /\$\('#board-controls'\)\.addEventListener\('input'/);
  assert.match(app, /\$\('#board-controls'\)\.addEventListener\('change'/);
});
