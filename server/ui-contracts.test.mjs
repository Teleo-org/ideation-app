import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const shared = readFileSync(new URL('../public/share.js', import.meta.url), 'utf8');
const controls = readFileSync(new URL('../public/board-controls.mjs', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const posthog = readFileSync(new URL('../public/posthog.mjs', import.meta.url), 'utf8');

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
  assert.match(styles, /\.group-filter > div \{ position: absolute/);
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

test('analytics is opt-in, self-hosted-safe, and explicit-only', () => {
  assert.match(app, /ANALYTICS_CONSENT_KEY/);
  assert.match(index, /id="analytics-consent"/);
  assert.match(app, /function renderAnalyticsConsentPrompt\(\)/);
  assert.match(index, /data-action="set-analytics-consent"/);
  assert.match(app, /if \(selfHosted\) return showToast\('Analytics is unavailable/);
  assert.match(app, /import\('\/posthog\.mjs'\)/);
  assert.doesNotMatch(app, /posthogReady/);
  assert.match(posthog, /autocapture: false/);
  assert.match(posthog, /capture_pageview: false/);
  assert.match(posthog, /capture_pageleave: false/);
  assert.match(posthog, /disable_session_recording: true/);
  assert.doesNotMatch(posthog, /email/);
  assert.match(app, /recordPersistedEvent\('idea_created'/);
  assert.match(app, /decision_lock_update_attempted/);
});

test('implementation selection does not render a decision preview banner', () => {
  assert.doesNotMatch(app, /Decision preview:/);
  assert.doesNotMatch(app, /data-action="clear-selection"/);
});

test('private client shell contains every startup control host used by app bootstrap', () => {
  for (const id of ['app', 'account-button', 'board-controls', 'board', 'inspector', 'modal', 'modal-title', 'modal-body', 'toast']) {
    assert.match(index, new RegExp(`id="${id}"`), `#${id} is present in the initial document`);
  }
  assert.match(app, /\$\('#board-controls'\)\.addEventListener\('input'/);
  assert.match(app, /\$\('#board-controls'\)\.addEventListener\('change'/);
});

test('shared controls preserve the private search wiring and use a distinct shared search ID', () => {
  assert.match(controls, /const searchId = shared \? 'shared-search' : 'search-input'/);
  assert.match(app, /event\.target\.id === 'search-input'/);
  assert.match(shared, /event\.target\.id === 'shared-search'/);
});

test('idea titles open the idea details inspector while chevrons control inline descriptions', () => {
  assert.match(app, /class="idea-title-button" data-action="open-idea-inspector"/);
  assert.match(app, /data-action="toggle-idea-details" data-id="\$\{idea\.id\}" title="Toggle details"/);
  assert.match(app, /<h2>Idea details<\/h2>/);
  assert.match(app, /id="idea-inspector-form"/);
  assert.match(styles, /\.idea-title-button \{ display: block; width: 100%/);
});
