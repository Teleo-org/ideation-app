import {
  blendBackground,
  blockingConflicts,
  effectiveConflicts,
  effectiveImplementations,
  normalizeLocked,
  readableTextColor,
  themeChain,
} from './core.mjs';
import { modeGlyph, modeLabel, nextMode, normalizeMode, resolveThemeMode } from './theme-mode.mjs';
import { generateExportMarkdown, stripBoldFromState, parseImportMarkdown } from './export.mjs';
import { Clerk } from '@clerk/clerk-js';
import { downloadProjectZip, exportProjectDirectory, importProjectDirectory, importProjectFile } from './portable.mjs';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const gate = $('#project-gate');
const app = $('#app');
const modal = $('#modal');
const modalTitle = $('#modal-title');
const modalBody = $('#modal-body');
const toast = $('#toast');

let state = null;
let projectPath = '';
let currentInspectorId = null;
let focusedConflictId = null;
let saveTimer = null;
let modalSubmitHandler = null;
let lastSavedSnapshot = '';
let includedProjects = [];
let storageMode = null;
let clerk = null;
let guestState = null;
const GUEST_STORAGE_KEY = 'ideation-workbench:guest-state:v1';

function guestDefaultState(name = 'My Ideation Project') {
  const themeId = id();
  const stamp = new Date().toISOString();
  return { version: 1, meta: { id: id(), name, createdAt: stamp, updatedAt: stamp }, themes: [{ id: themeId, name: 'Core', parentId: null, hiddenInheritedImplementationIds: [], hiddenInheritedConflictIds: [] }], ideaGroups: [], implementationGroups: [], ideas: [], implementations: [], groupLinks: [], conflicts: [], savedViews: [], uiByTheme: { [themeId]: defaultView() }, activeThemeId: themeId };
}

function readGuestState() {
  try { return JSON.parse(localStorage.getItem(GUEST_STORAGE_KEY) || 'null') || guestDefaultState(); }
  catch { return guestDefaultState(); }
}

function saveGuestState(next) {
  guestState = structuredClone(next);
  localStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify(guestState));
  return guestState;
}

async function api(path, options = {}) {
  if (storageMode === 'guest') {
    if (path === '/api/status') return { authenticated: false, provisioned: false, open: true, path: 'This browser (not uploaded)', state: structuredClone(guestState) };
    if (path === '/api/state' && (!options.method || options.method === 'GET')) return structuredClone(guestState);
    if (path === '/api/state' && options.method === 'PUT') return saveGuestState(JSON.parse(options.body));
    if (path === '/api/backup') return { ok: true, local: true };
    if (path.startsWith('/api/attachments')) throw new Error('Attachments in guest mode are not available yet. Sign in to add cloud attachments.');
    return { projects: [] };
  }
  const headers = new Headers(options.headers || {});
  if (clerk?.session) {
    const token = await clerk.session.getToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }
  const response = await fetch(path, { ...options, headers });
  const isJson = response.headers.get('content-type')?.includes('application/json');
  const payload = isJson ? await response.json() : await response.text();
  if (!response.ok) throw new Error(payload?.error || payload || `Request failed: ${response.status}`);
  return payload;
}

const escapeHtml = (value = '') => String(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

const COLOR_MODE_KEY = 'iw-theme';
const colorScheme = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
let colorMode = normalizeMode(localStorage.getItem(COLOR_MODE_KEY));

function effectiveColorMode() {
  return resolveThemeMode(colorMode, Boolean(colorScheme && colorScheme.matches));
}

function applyColorMode() {
  if (colorMode === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', colorMode);
  const resolved = effectiveColorMode();
  document.querySelectorAll('[data-action="cycle-color-mode"]').forEach((button) => {
    const glyph = button.querySelector('.mode-glyph');
    if (glyph) glyph.textContent = modeGlyph(colorMode);
    const label = modeLabel(colorMode) === 'Auto' ? `Auto (${resolved === 'dark' ? 'Dark' : 'Light'})` : modeLabel(colorMode);
    button.title = `Color theme: ${label}`;
    button.setAttribute('aria-label', `Color theme: ${label}. Click to switch.`);
  });
}

function cycleColorMode() {
  colorMode = nextMode(colorMode);
  try { if (colorMode === 'auto') localStorage.removeItem(COLOR_MODE_KEY); else localStorage.setItem(COLOR_MODE_KEY, colorMode); } catch (e) {}
  applyColorMode();
}

applyColorMode();
if (colorScheme) colorScheme.addEventListener('change', applyColorMode);

function sanitizeHtml(value = '') {
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${value}</div>`, 'text/html');
  const allowedTags = new Set(['DIV', 'P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'CODE', 'PRE', 'A']);
  for (const node of [...doc.body.querySelectorAll('*')]) {
    if (!allowedTags.has(node.tagName)) {
      node.replaceWith(...node.childNodes);
      continue;
    }
    for (const attr of [...node.attributes]) {
      const keepHref = node.tagName === 'A' && attr.name === 'href' && /^(https?:|mailto:|#)/i.test(attr.value);
      if (!keepHref) node.removeAttribute(attr.name);
    }
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  }
  return doc.body.firstElementChild?.innerHTML || '';
}

function id() { return crypto.randomUUID(); }
function byId(list, itemId) { return list.find((item) => item.id === itemId); }
function unique(values) { return [...new Set(values)]; }
function numberSort(a, b) { return (a.sortOrder || 0) - (b.sortOrder || 0) || a.title.localeCompare(b.title); }
function themeName(themeId) { return byId(state.themes, themeId)?.name || 'Unknown theme'; }
function activeTheme() { return byId(state.themes, state.activeThemeId); }
function conflictsForTheme() { return effectiveConflicts(state, state.activeThemeId); }
function implementationsForTheme() { return effectiveImplementations(state, state.activeThemeId); }

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 2600);
}

function setStatus(message) { $('#save-status').textContent = message; }

function defaultView() {
  return {
    lockedImplementationIds: [], visibleImplementationIds: [], previousVisibleImplementationIds: [],
    expandedIdeaIds: [], expandedImplementationIds: [], showExcluded: true, search: '', ideaGroupFilter: 'all',
    knownImplementationIds: [],
  };
}

function view() {
  state.uiByTheme ||= {};
  state.uiByTheme[state.activeThemeId] ||= defaultView();
  const target = state.uiByTheme[state.activeThemeId];
  for (const [key, value] of Object.entries(defaultView())) if (!(key in target)) target[key] = structuredClone(value);
  syncViewWithTheme(target);
  return target;
}

function syncViewWithTheme(target) {
  const effectiveIds = implementationsForTheme().map((item) => item.id);
  const effectiveSet = new Set(effectiveIds);
  const known = new Set(target.knownImplementationIds || []);
  const newlyEffective = effectiveIds.filter((itemId) => !known.has(itemId));
  target.visibleImplementationIds = unique([
    ...(target.visibleImplementationIds || []).filter((itemId) => effectiveSet.has(itemId)),
    ...newlyEffective,
  ]);
  target.previousVisibleImplementationIds = (target.previousVisibleImplementationIds || []).filter((itemId) => effectiveSet.has(itemId));
  target.lockedImplementationIds = normalizeLocked(conflictsForTheme(), (target.lockedImplementationIds || []).filter((itemId) => effectiveSet.has(itemId)));
  target.expandedImplementationIds = (target.expandedImplementationIds || []).filter((itemId) => effectiveSet.has(itemId));
  target.knownImplementationIds = effectiveIds;
}

function markDirty() {
  if (!state) return;
  setStatus('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 450);
}

async function saveState() {
  if (!state) return;
  try {
    const snapshot = JSON.stringify(state);
    if (snapshot === lastSavedSnapshot) { setStatus('Saved'); return; }
    const saved = await api('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: snapshot });
    state.meta.updatedAt = saved.meta.updatedAt;
    lastSavedSnapshot = JSON.stringify(state);
    setStatus(`Saved ${new Date(state.meta.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
  } catch (error) {
    setStatus('Save failed');
    showToast(error.message);
  }
}

function themeOptions(selectedId, excludeIds = []) {
  const excluded = new Set(excludeIds);
  const children = new Map();
  for (const theme of state.themes) {
    const parent = theme.parentId || '__root__';
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(theme);
  }
  for (const list of children.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  const result = [];
  const walk = (parentId, depth) => {
    for (const theme of children.get(parentId) || []) {
      if (!excluded.has(theme.id)) result.push(`<option value="${theme.id}" ${theme.id === selectedId ? 'selected' : ''}>${'— '.repeat(depth)}${escapeHtml(theme.name)}</option>`);
      walk(theme.id, depth + 1);
    }
  };
  walk('__root__', 0);
  return result.join('');
}

function checkboxGrid(name, items, selected = [], labeler = (item) => item.name || item.title || 'Untitled group') {
  const selectedSet = new Set(selected);
  if (!items.length) return '<p class="muted">Nothing available yet.</p>';
  return `<div class="checkbox-grid">${items.map((item) => `
    <label class="checkbox-item"><input type="checkbox" name="${name}" value="${item.id}" ${selectedSet.has(item.id) ? 'checked' : ''} /><span>${escapeHtml(labeler(item))}</span></label>
  `).join('')}</div>`;
}

function richEditor(value = '', placeholder = 'Add details…') {
  return `<div class="rich-editor-shell">
    <div class="rich-editor" contenteditable="true" data-rich-editor data-placeholder="${escapeHtml(placeholder)}" tabindex="0">${sanitizeHtml(value)}</div>
    <div class="rich-toolbar">
      <button type="button" data-rich-cmd="bold" title="Bold" tabindex="-1">B</button>
      <button type="button" data-rich-cmd="italic" title="Italic" tabindex="-1"><em>I</em></button>
      <button type="button" data-rich-cmd="underline" title="Underline" tabindex="-1"><u>U</u></button>
      <button type="button" data-rich-cmd="insertUnorderedList" title="Bulleted list" tabindex="-1">• List</button>
      <button type="button" data-rich-cmd="insertOrderedList" title="Numbered list" tabindex="-1">1. List</button>
      <button type="button" data-rich-cmd="formatBlock" data-rich-value="blockquote" title="Quote" tabindex="-1">Quote</button>
      <button type="button" data-rich-cmd="removeFormat" title="Clear formatting" tabindex="-1">Clear</button>
    </div>
  </div>`;
}

function modalForm(title, body, onSubmit, submitLabel = 'Save') {
  modalTitle.textContent = title;
  modalBody.innerHTML = `<form id="modal-form">${body}<div class="form-actions"><button type="button" class="button ghost" data-action="close-modal">Cancel</button><button type="submit" class="button primary">${escapeHtml(submitLabel)}</button></div></form>`;
  modalSubmitHandler = onSubmit;
  modal.showModal();
}

function modalManager(title, body) {
  modalTitle.textContent = title;
  modalBody.innerHTML = body;
  modalSubmitHandler = null;
  modal.showModal();
}

function closeModal() {
  modal.close();
  modalBody.innerHTML = '';
  modalSubmitHandler = null;
}

function getRichValue(root = modalBody) {
  return sanitizeHtml($('[data-rich-editor]', root)?.innerHTML || '');
}

function renderThemePicker() {
  $('#theme-select').innerHTML = themeOptions(state.activeThemeId);
}

function renderFilters() {
  const v = view();
  $('#search-input').value = v.search;
  $('#show-excluded').checked = v.showExcluded;
  $('#idea-group-filter').innerHTML = `<option value="all">All groups</option><option value="ungrouped">Ungrouped</option>${state.ideaGroups.map((group) => `<option value="${group.id}" ${v.ideaGroupFilter === group.id ? 'selected' : ''}>${escapeHtml(group.name || 'Untitled group')}</option>`).join('')}`;
  $('#idea-group-filter').value = v.ideaGroupFilter;
  $('#lock-count').textContent = `${v.lockedImplementationIds.length} locked`;
}

function ideaCardStyle(idea) {
  const colors = idea.groupIds.map((groupId) => byId(state.ideaGroups, groupId)?.color).filter(Boolean);
  return `--idea-bg:${blendBackground(colors)};--idea-fg:${readableTextColor(colors)};`;
}

function implementationBadges(implementation, blockers, conflicts, directInTheme) {
  const badges = [];
  if (!directInTheme) badges.push(`<span class="micro-badge">Inherited</span>`);
  if (implementation.groupIds.length) badges.push(`<span class="micro-badge">${implementation.groupIds.length} impl group${implementation.groupIds.length === 1 ? '' : 's'}</span>`);
  if (blockers.length) badges.push(`<span class="micro-badge warning">${blockers.length} blocking conflict${blockers.length === 1 ? '' : 's'}</span>`);
  for (const conflict of conflicts.slice(0, 3)) badges.push(`<button class="micro-badge conflict" data-action="focus-conflict" data-id="${conflict.id}" title="${escapeHtml(conflict.name)}">${escapeHtml(conflict.name)}</button>`);
  if (conflicts.length > 3) badges.push(`<span class="micro-badge">+${conflicts.length - 3}</span>`);
  return badges.join('');
}

function renderImplementationRow(implementation, allConflicts, v) {
  const locked = v.lockedImplementationIds.includes(implementation.id);
  const blockers = locked ? [] : blockingConflicts(allConflicts, v.lockedImplementationIds, implementation.id);
  if (blockers.length && !v.showExcluded) return '';
  const relatedConflicts = allConflicts.filter((conflict) => conflict.implementationIds.includes(implementation.id));
  const expanded = v.expandedImplementationIds.includes(implementation.id);
  const selected = currentInspectorId === implementation.id;
  const focused = focusedConflictId ? byId(allConflicts, focusedConflictId) : null;
  const focusClass = focusedConflictId ? (focused?.implementationIds.includes(implementation.id) ? 'conflict-member' : 'conflict-muted') : '';
  return `<article class="impl-row ${locked ? 'locked' : ''} ${selected ? 'selected' : ''} ${blockers.length ? 'incompatible' : ''} ${focusClass}" data-implementation-id="${implementation.id}">
    <button class="lock-button ${locked ? 'active' : ''}" data-action="toggle-lock" data-id="${implementation.id}" ${blockers.length ? 'disabled' : ''} title="${locked ? 'Unlock' : blockers.length ? 'Would complete a conflict' : 'Lock'}">${locked ? '✓' : '○'}</button>
    <div class="impl-main">
      <button class="impl-title-button" data-action="open-inspector" data-id="${implementation.id}">${escapeHtml(implementation.title)}</button>
      <div class="impl-subline">${implementationBadges(implementation, blockers, relatedConflicts, implementation.directInTheme)}</div>
    </div>
    <div class="impl-actions">
      <button data-action="toggle-impl-details" data-id="${implementation.id}" title="Toggle details">${expanded ? '▴' : '▾'}</button>
      <button data-action="hide-implementation" data-id="${implementation.id}" title="Hide in this view">◉</button>
    </div>
    ${expanded && implementation.detailsHtml ? `<div class="impl-details">${sanitizeHtml(implementation.detailsHtml)}</div>` : ''}
  </article>`;
}

function renderBoard() {
  const board = $('#board');
  const v = view();
  const effective = implementationsForTheme();
  const effectiveById = new Map(effective.map((item) => [item.id, item]));
  const allConflicts = conflictsForTheme();
  const visible = new Set(v.visibleImplementationIds);
  const search = v.search.trim().toLowerCase();
  const ideas = state.ideas
    .filter((idea) => v.ideaGroupFilter === 'all' || (v.ideaGroupFilter === 'ungrouped' ? !idea.groupIds.length : idea.groupIds.includes(v.ideaGroupFilter)))
    .filter((idea) => {
      if (!search) return true;
      const ideaMatches = `${idea.title} ${idea.detailsHtml || ''}`.toLowerCase().includes(search);
      const implementationMatches = effective.some((implementation) => implementation.ideaIds.includes(idea.id) && `${implementation.title} ${implementation.detailsHtml || ''}`.toLowerCase().includes(search));
      return ideaMatches || implementationMatches;
    })
    .sort(numberSort);

  if (!ideas.length) {
    board.innerHTML = `<div class="gate-card" style="display:inline-block;width:100%;"><h2>${state.ideas.length ? 'No ideas match this view' : 'Start with an idea'}</h2><p class="muted">Ideas stay global; implementations shown beneath them are filtered through the selected theme and its ancestors.</p><button class="button primary" data-action="add-idea">+ Add idea</button></div>`;
  } else {
    board.innerHTML = ideas.map((idea) => {
      const groups = idea.groupIds.map((groupId) => byId(state.ideaGroups, groupId)).filter(Boolean);
      const linkedImplementationGroups = unique(state.groupLinks.filter((link) => idea.groupIds.includes(link.ideaGroupId)).map((link) => link.implementationGroupId))
        .map((groupId) => byId(state.implementationGroups, groupId)).filter(Boolean);
      const implementations = effective.filter((implementation) => implementation.ideaIds.includes(idea.id));
      const visibleImplementations = implementations.filter((implementation) => visible.has(implementation.id));
      const hiddenImplementations = implementations.filter((implementation) => !visible.has(implementation.id));
      const sortedVisible = [...visibleImplementations].sort((a, b) => {
        const aLocked = v.lockedImplementationIds.includes(a.id) ? 0 : 1;
        const bLocked = v.lockedImplementationIds.includes(b.id) ? 0 : 1;
        if (aLocked !== bLocked) return aLocked - bLocked;
        const aBlockers = aLocked === 0 ? 0 : blockingConflicts(allConflicts, v.lockedImplementationIds, a.id).length;
        const bBlockers = bLocked === 0 ? 0 : blockingConflicts(allConflicts, v.lockedImplementationIds, b.id).length;
        if (Boolean(aBlockers) !== Boolean(bBlockers)) return aBlockers ? 1 : -1;
        if (aBlockers !== bBlockers) return aBlockers - bBlockers;
        return numberSort(a, b);
      });
      const expanded = v.expandedIdeaIds.includes(idea.id);
      return `<section class="idea-card" style="${ideaCardStyle(idea)}">
        <header class="idea-header">
          <div>
            <h2 class="idea-title">${escapeHtml(idea.title)}</h2>
            <div class="badge-row">
              ${groups.map((group) => `<span class="badge"><span class="color-dot" style="background:${group.color || '#d5dbe5'}"></span>${escapeHtml(group.name || 'Untitled group')}</span>`).join('')}
              ${linkedImplementationGroups.map((group) => `<span class="badge semantic">↔ ${escapeHtml(group.name || 'Untitled group')}</span>`).join('')}
              ${!groups.length ? '<span class="badge">Ungrouped</span>' : ''}
            </div>
          </div>
          <div class="idea-actions">
            <button class="icon-button" data-action="toggle-idea-details" data-id="${idea.id}" title="Toggle details">${expanded ? '▴' : '▾'}</button>
            <button class="icon-button" data-action="edit-idea" data-id="${idea.id}" title="Edit idea">✎</button>
            <button class="icon-button" data-action="add-implementation" data-idea-id="${idea.id}" title="Add implementation">＋</button>
          </div>
        </header>
        ${expanded && idea.detailsHtml ? `<div class="idea-details">${sanitizeHtml(idea.detailsHtml)}</div>` : ''}
        <div class="implementation-list">
          ${sortedVisible.length ? sortedVisible.map((implementation) => renderImplementationRow(implementation, allConflicts, v)).join('') : `<div class="empty-impl">${implementations.length ? 'All implementations are hidden.' : 'No implementation in this theme.'}</div>`}
          ${hiddenImplementations.length ? `<div class="hidden-strip">${hiddenImplementations.map((implementation) => `<span class="hidden-chip">${escapeHtml(implementation.title)} <button data-action="show-implementation" data-id="${implementation.id}">show</button></span>`).join('')}</div>` : ''}
        </div>
      </section>`;
    }).join('');
  }

  const focusBanner = $('#conflict-focus-banner');
  const focused = focusedConflictId ? byId(allConflicts, focusedConflictId) : null;
  if (focused) {
    focusBanner.hidden = false;
    focusBanner.innerHTML = `<strong>${escapeHtml(focused.name)}</strong>${focused.detailsHtml ? ` — ${stripHtml(focused.detailsHtml).slice(0, 180)}` : ''} <button class="link-button" data-action="clear-conflict-focus">Clear highlight</button>`;
  } else focusBanner.hidden = true;
}

function stripHtml(value = '') {
  const doc = new DOMParser().parseFromString(value, 'text/html');
  return doc.body.textContent || '';
}

function renderInspector() {
  const workspace = $('.workspace');
  const inspector = $('#inspector');
  const effective = implementationsForTheme();
  const implementation = currentInspectorId ? byId(state.implementations, currentInspectorId) : null;
  if (!implementation || !effective.some((item) => item.id === implementation.id)) {
    currentInspectorId = null;
    workspace.classList.remove('has-inspector');
    inspector.hidden = true;
    inspector.innerHTML = '';
    return;
  }
  workspace.classList.add('has-inspector');
  inspector.hidden = false;
  const effectiveItem = effective.find((item) => item.id === implementation.id);
  const relatedConflicts = conflictsForTheme().filter((conflict) => conflict.implementationIds.includes(implementation.id));
  const inherited = !implementation.themeIds.includes(state.activeThemeId);
  inspector.innerHTML = `<form id="inspector-form">
    <h2>Implementation details</h2>
    <p class="tiny muted">One underlying implementation, repeated beneath every linked idea.</p>
    <label class="field"><span>Title</span><input name="title" value="${escapeHtml(implementation.title)}" required /></label>
    <label class="field"><span>Details / notes</span>${richEditor(implementation.detailsHtml || '', 'Arbitrary rich-text notes…')}</label>
    <div class="inspector-actions"><button type="submit" class="button primary">Save details</button><button type="button" class="button ghost" data-action="edit-implementation" data-id="${implementation.id}">Edit relationships</button><button type="button" class="button danger" data-action="delete-implementation" data-id="${implementation.id}">Delete</button></div>
  </form>
  <section class="inspector-section"><h3>Theme origin</h3><div class="inspector-list">${effectiveItem.originThemeIds.map((themeId) => `<div class="inspector-item"><span>${escapeHtml(themeName(themeId))}</span><span>${themeId === state.activeThemeId ? 'Direct' : 'Inherited'}</span></div>`).join('')}</div>
    ${inherited ? `<div class="inspector-actions"><button class="button secondary compact" data-action="make-direct" data-id="${implementation.id}">Make direct here</button><button class="button ghost compact" data-action="hide-inherited" data-id="${implementation.id}">Hide in this theme</button></div>` : ''}
  </section>
  <section class="inspector-section"><h3>Ideas</h3><div class="inspector-list">${implementation.ideaIds.map((ideaId) => byId(state.ideas, ideaId)).filter(Boolean).map((idea) => `<div class="inspector-item"><span>${escapeHtml(idea.title)}</span></div>`).join('')}</div></section>
  <section class="inspector-section"><h3>Conflicts</h3>${relatedConflicts.length ? `<div class="inspector-list">${relatedConflicts.map((conflict) => `<button type="button" class="inspector-item" data-action="focus-conflict" data-id="${conflict.id}"><span>${escapeHtml(conflict.name)}</span><span>${conflict.implementationIds.length} members</span></button>`).join('')}</div>` : '<p class="muted">No conflicts in this theme.</p>'}</section>
  <section class="inspector-section"><h3>Attachments</h3>
    <div class="attachment-list">${(implementation.attachments || []).map((attachment) => `<div class="attachment-row"><a href="${attachment.url}" target="_blank" rel="noopener">${escapeHtml(attachment.name)}</a><button class="link-button" data-action="delete-attachment" data-id="${implementation.id}" data-storage="${escapeHtml(attachment.storageName)}">remove</button></div>`).join('')}</div>
    <label class="field"><span>Add local file</span><input id="attachment-input" type="file" data-implementation-id="${implementation.id}" /></label>
  </section>`;
}

function renderStats() {
  $('#project-title').textContent = state.meta.name;
  $('#project-location').textContent = projectPath;
  $('#project-stats').textContent = `${state.ideas.length} ideas · ${state.implementations.length} implementations · ${state.conflicts.length} conflicts`;
}

function render() {
  if (!state) return;
  renderThemePicker();
  renderFilters();
  renderBoard();
  renderInspector();
  renderStats();
}

function renderIncludedProjects() {
  const section = $('#included-projects');
  const select = $('#included-project-select');
  if (!includedProjects.length) {
    section.hidden = true;
    select.innerHTML = '';
    return;
  }
  section.hidden = false;
  select.innerHTML = includedProjects.map((project) => `<option value="${escapeHtml(project.path)}">${escapeHtml(project.name)} — ${escapeHtml(project.relativePath)}</option>`).join('');
}

async function loadIncludedProjects() {
  includedProjects = [];
  renderIncludedProjects();
}

function openWorkbench(status) {
  state = status.state;
  projectPath = status.path;
  if (stripBoldFromState(state)) markDirty();
  lastSavedSnapshot = JSON.stringify(state);
  gate.hidden = true;
  app.hidden = false;
  render();
}

async function loadStatus() {
  try {
    const status = await api('/api/status');
    if (status.open) return openWorkbench(status);
    gate.hidden = false; app.hidden = true;
    if (status.authenticated && !status.provisioned) $('#gate-error').textContent = 'Cloud storage is full for self-service accounts. You can continue in this browser or use an invitation.';
  } catch (error) {
    $('#gate-error').textContent = error.message;
  }
}

async function continueAsGuest() {
  storageMode = 'guest'; guestState = readGuestState(); await loadStatus();
}

async function initializeClerk() {
  const config = await fetch('/api/config').then((response) => response.json());
  if (!config.clerkPublishableKey) throw new Error('Authentication is not configured yet.');
  clerk = new Clerk(config.clerkPublishableKey);
  await clerk.load({ afterSignInUrl: window.location.href, afterSignUpUrl: window.location.href });
  $('#sign-out-button').hidden = !clerk.user;
}

async function boot() {
  $('#project-path')?.closest('.field')?.setAttribute('hidden', '');
  $('#project-name')?.closest('.field')?.setAttribute('hidden', '');
  $('[data-action="open-project"]')?.setAttribute('hidden', '');
  $('#included-projects')?.setAttribute('hidden', '');
  try {
    await initializeClerk();
    if (clerk.user) { storageMode = 'cloud'; await loadStatus(); }
  } catch (error) { $('#gate-error').textContent = error.message; }
}

function openIdeaForm(ideaId = null) {
  const idea = ideaId ? byId(state.ideas, ideaId) : null;
  modalForm(idea ? 'Edit idea' : 'Add idea', `
    <div class="form-grid">
      <label class="field full"><span>Succinct title</span><input name="title" value="${escapeHtml(idea?.title || '')}" required autofocus /></label>
      <label class="field full"><span>Idea groups</span>${checkboxGrid('groupIds', state.ideaGroups, idea?.groupIds || [])}</label>
      <label class="field full"><span>Details</span>${richEditor(idea?.detailsHtml || '', 'Arbitrary details for this idea…')}</label>
    </div>
    ${idea ? `<button type="button" class="button danger" data-action="delete-idea" data-id="${idea.id}">Delete idea</button>` : ''}
  `, async (form) => {
    const formData = new FormData(form);
    const title = String(formData.get('title') || '').trim();
    if (!title) throw new Error('A title is required.');
    const payload = {
      id: idea?.id || id(), title, detailsHtml: getRichValue(), groupIds: formData.getAll('groupIds').map(String), sortOrder: idea?.sortOrder ?? state.ideas.length,
    };
    if (idea) Object.assign(idea, payload); else state.ideas.push(payload);
    closeModal(); render(); markDirty();
  });
}

function openImplementationForm(implementationId = null, preselectedIdeaId = null) {
  const implementation = implementationId ? byId(state.implementations, implementationId) : null;
  modalForm(implementation ? 'Edit implementation' : 'Add implementation', `
    <div class="form-grid">
      <label class="field full"><span>Succinct title</span><input name="title" value="${escapeHtml(implementation?.title || '')}" required autofocus /></label>
      <label class="field full"><span>Details / notes</span>${richEditor(implementation?.detailsHtml || '', 'Describe this implementation…')}</label>
      <label class="field full"><span>Themes</span>${checkboxGrid('themeIds', state.themes, implementation?.themeIds || [state.activeThemeId], (item) => item.name)}</label>
      <label class="field full"><span>Ideas</span>${checkboxGrid('ideaIds', state.ideas, implementation?.ideaIds || (preselectedIdeaId ? [preselectedIdeaId] : []), (item) => item.title)}</label>
      <label class="field full"><span>Implementation groups</span>${checkboxGrid('groupIds', state.implementationGroups, implementation?.groupIds || [])}</label>
    </div>
  `, async (form) => {
    const formData = new FormData(form);
    const title = String(formData.get('title') || '').trim();
    const ideaIds = formData.getAll('ideaIds').map(String);
    const themeIds = formData.getAll('themeIds').map(String);
    if (!title) throw new Error('A title is required.');
    if (!ideaIds.length) throw new Error('An implementation must link to at least one idea.');
    if (!themeIds.length) throw new Error('Choose at least one theme.');
    const payload = {
      id: implementation?.id || id(), title, detailsHtml: getRichValue(), ideaIds, themeIds,
      groupIds: formData.getAll('groupIds').map(String), sortOrder: implementation?.sortOrder ?? state.implementations.length,
      attachments: implementation?.attachments || [],
    };
    if (implementation) Object.assign(implementation, payload); else state.implementations.push(payload);
    currentInspectorId = payload.id;
    closeModal(); render(); markDirty();
  });
}

function openConflictForm(conflictId = null, overridesConflictId = null) {
  const conflict = conflictId ? byId(state.conflicts, conflictId) : null;
  const base = overridesConflictId ? byId(state.conflicts, overridesConflictId) : null;
  const selectedIds = conflict?.implementationIds || base?.implementationIds || [];
  const selectedScope = conflict ? (conflict.themeId ?? 'global') : state.activeThemeId;
  modalForm(conflict ? 'Edit conflict' : overridesConflictId ? 'Override inherited conflict' : 'Add conflict', `
    <div class="form-grid">
      <label class="field full"><span>Name</span><input name="name" value="${escapeHtml(conflict?.name || base?.name || '')}" required autofocus /></label>
      <label class="field"><span>Scope</span><select name="themeId"><option value="global" ${selectedScope === 'global' ? 'selected' : ''}>Global</option>${state.themes.map((theme) => `<option value="${theme.id}" ${selectedScope === theme.id ? 'selected' : ''}>${escapeHtml(theme.name)}</option>`).join('')}</select></label>
      <div></div>
      <label class="field full"><span>Members — the conflict activates only when every selected member is locked</span>${checkboxGrid('implementationIds', state.implementations, selectedIds, (item) => item.title)}</label>
      <label class="field full"><span>Explanation</span>${richEditor(conflict?.detailsHtml || base?.detailsHtml || '', 'Why is the complete combination invalid?')}</label>
    </div>
  `, async (form) => {
    const formData = new FormData(form);
    const name = String(formData.get('name') || '').trim();
    const implementationIds = formData.getAll('implementationIds').map(String);
    if (!name) throw new Error('A conflict name is required.');
    if (implementationIds.length < 2) throw new Error('A conflict needs at least two implementations.');
    const rawThemeId = String(formData.get('themeId'));
    const payload = {
      id: conflict?.id || id(), name, detailsHtml: getRichValue(), themeId: rawThemeId === 'global' ? null : rawThemeId,
      implementationIds, overridesConflictId: conflict?.overridesConflictId || overridesConflictId || null,
    };
    if (conflict) Object.assign(conflict, payload); else state.conflicts.push(payload);
    closeModal(); render(); markDirty();
  });
}

function descendantsOf(themeId) {
  const result = [];
  const walk = (parentId) => {
    for (const theme of state.themes.filter((item) => item.parentId === parentId)) { result.push(theme.id); walk(theme.id); }
  };
  walk(themeId);
  return result;
}

function openThemeForm(themeId = null, returnToStructure = true) {
  const theme = themeId ? byId(state.themes, themeId) : null;
  const excluded = theme ? [theme.id, ...descendantsOf(theme.id)] : [];
  modalForm(theme ? 'Edit theme' : 'Add theme', `
    <div class="form-grid"><label class="field full"><span>Name</span><input name="name" value="${escapeHtml(theme?.name || '')}" required autofocus /></label>
    <label class="field full"><span>Parent theme</span><select name="parentId"><option value="">No parent</option>${themeOptions(theme?.parentId || '', excluded)}</select></label></div>
  `, async (form) => {
    const data = new FormData(form);
    const name = String(data.get('name') || '').trim();
    if (!name) throw new Error('A name is required.');
    if (theme) { theme.name = name; theme.parentId = String(data.get('parentId') || '') || null; }
    else {
      const newTheme = { id: id(), name, parentId: String(data.get('parentId') || '') || null, hiddenInheritedImplementationIds: [], hiddenInheritedConflictIds: [] };
      state.themes.push(newTheme); state.uiByTheme[newTheme.id] = defaultView(); state.activeThemeId = newTheme.id;
    }
    closeModal(); render(); markDirty();
    if (returnToStructure) openStructureManager(); else showToast(theme ? 'Theme updated.' : 'Theme created and selected.');
  });
}

function openGroupForm(kind, groupId = null) {
  const list = kind === 'idea' ? state.ideaGroups : state.implementationGroups;
  const group = groupId ? byId(list, groupId) : null;
  modalForm(`${group ? 'Edit' : 'Add'} ${kind === 'idea' ? 'idea' : 'implementation'} group`, `
    <div class="form-grid">
      <label class="field full"><span>Name <small>(optional)</small></span><input name="name" value="${escapeHtml(group?.name || '')}" autofocus /></label>
      <label class="field"><span>Color <small>(optional #RRGGBB)</small></span><input name="color" type="text" placeholder="#c7d7ff" value="${escapeHtml(group?.color || '')}" /></label><div></div>
      <label class="field full"><span>Description <small>(optional)</small></span><textarea name="description" rows="3">${escapeHtml(group?.description || '')}</textarea></label>
    </div>
  `, async (form) => {
    const data = new FormData(form);
    const name = String(data.get('name') || '').trim();
    const color = String(data.get('color') || '').trim();
    if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error('Use a six-digit hex color such as #c7d7ff, or leave it blank.');
    const payload = { id: group?.id || id(), name, color, description: String(data.get('description') || '').trim() };
    if (group) Object.assign(group, payload); else list.push(payload);
    closeModal(); render(); markDirty(); openStructureManager();
  });
}

function openGroupLinkForm(linkId = null) {
  const link = linkId ? byId(state.groupLinks, linkId) : null;
  modalForm(link ? 'Edit group connection' : 'Add group connection', `
    <div class="form-grid"><label class="field"><span>Idea group</span><select name="ideaGroupId">${state.ideaGroups.map((group) => `<option value="${group.id}" ${link?.ideaGroupId === group.id ? 'selected' : ''}>${escapeHtml(group.name || 'Untitled group')}</option>`).join('')}</select></label>
    <label class="field"><span>Implementation group</span><select name="implementationGroupId">${state.implementationGroups.map((group) => `<option value="${group.id}" ${link?.implementationGroupId === group.id ? 'selected' : ''}>${escapeHtml(group.name || 'Untitled group')}</option>`).join('')}</select></label>
    <label class="field full"><span>Description <small>(semantic relationship only; it does not expand into individual links)</small></span><textarea name="description" rows="3">${escapeHtml(link?.description || '')}</textarea></label></div>
  `, async (form) => {
    const data = new FormData(form);
    if (!state.ideaGroups.length || !state.implementationGroups.length) throw new Error('Create both kinds of groups first.');
    const payload = { id: link?.id || id(), ideaGroupId: String(data.get('ideaGroupId')), implementationGroupId: String(data.get('implementationGroupId')), description: String(data.get('description') || '').trim() };
    if (link) Object.assign(link, payload); else state.groupLinks.push(payload);
    closeModal(); render(); markDirty(); openStructureManager();
  });
}

function openStructureManager() {
  const row = (label, actions) => `<div class="manager-row"><div>${label}</div><div class="manager-row-actions">${actions}</div></div>`;
  modalManager('Structure', `
    <section class="manager-section"><div class="manager-heading"><h3>Themes</h3><button class="button secondary compact" data-action="add-theme">+ Theme</button></div>
      <div class="manager-list">${state.themes.map((theme) => row(`<strong>${escapeHtml(theme.name)}</strong>${theme.parentId ? `<div class="tiny muted">Child of ${escapeHtml(themeName(theme.parentId))}</div>` : ''}`, `<button class="button ghost" data-action="edit-theme" data-id="${theme.id}">Edit</button><button class="button danger" data-action="delete-theme" data-id="${theme.id}">Delete</button>`)).join('')}</div></section>
    <section class="manager-section"><div class="manager-heading"><h3>Idea groups</h3><button class="button secondary compact" data-action="add-group" data-kind="idea">+ Group</button></div>
      <div class="manager-list">${state.ideaGroups.length ? state.ideaGroups.map((group) => row(`<span class="color-dot" style="background:${group.color || '#d5dbe5'}"></span><strong>${escapeHtml(group.name || 'Untitled group')}</strong>${group.description ? `<div class="tiny muted">${escapeHtml(group.description)}</div>` : ''}`, `<button class="button ghost" data-action="edit-group" data-kind="idea" data-id="${group.id}">Edit</button><button class="button danger" data-action="delete-group" data-kind="idea" data-id="${group.id}">Delete</button>`)).join('') : '<p class="muted">No idea groups yet.</p>'}</div></section>
    <section class="manager-section"><div class="manager-heading"><h3>Implementation groups</h3><button class="button secondary compact" data-action="add-group" data-kind="implementation">+ Group</button></div>
      <div class="manager-list">${state.implementationGroups.length ? state.implementationGroups.map((group) => row(`<span class="color-dot" style="background:${group.color || '#d5dbe5'}"></span><strong>${escapeHtml(group.name || 'Untitled group')}</strong>${group.description ? `<div class="tiny muted">${escapeHtml(group.description)}</div>` : ''}`, `<button class="button ghost" data-action="edit-group" data-kind="implementation" data-id="${group.id}">Edit</button><button class="button danger" data-action="delete-group" data-kind="implementation" data-id="${group.id}">Delete</button>`)).join('') : '<p class="muted">No implementation groups yet.</p>'}</div></section>
    <section class="manager-section"><div class="manager-heading"><h3>Hidden inherited implementations in ${escapeHtml(activeTheme().name)}</h3></div>
      <div class="manager-list">${(activeTheme().hiddenInheritedImplementationIds || []).map((implementationId) => byId(state.implementations, implementationId)).filter(Boolean).map((implementation) => row(`<strong>${escapeHtml(implementation.title)}</strong>`, `<button class="button secondary" data-action="unhide-inherited" data-id="${implementation.id}">Restore</button>`)).join('') || '<p class="muted">Nothing hidden.</p>'}</div></section>
    <section class="manager-section"><div class="manager-heading"><h3>Group-to-group connections</h3><button class="button secondary compact" data-action="add-group-link">+ Connection</button></div>
      <p class="callout">These are persistent semantic relationships. They never expand into every possible idea-to-implementation link.</p>
      <div class="manager-list">${state.groupLinks.length ? state.groupLinks.map((link) => {
        const ideaGroup = byId(state.ideaGroups, link.ideaGroupId); const implGroup = byId(state.implementationGroups, link.implementationGroupId);
        return row(`<strong>${escapeHtml(ideaGroup ? (ideaGroup.name || 'Untitled group') : 'Missing group')} ↔ ${escapeHtml(implGroup ? (implGroup.name || 'Untitled group') : 'Missing group')}</strong>${link.description ? `<div class="tiny muted">${escapeHtml(link.description)}</div>` : ''}`, `<button class="button ghost" data-action="edit-group-link" data-id="${link.id}">Edit</button><button class="button danger" data-action="delete-group-link" data-id="${link.id}">Delete</button>`);
      }).join('') : '<p class="muted">No semantic group connections yet.</p>'}</div></section>
  `);
}

function openConflictManager() {
  const effectiveIds = new Set(conflictsForTheme().map((item) => item.id));
  const rows = state.conflicts.filter((conflict) => effectiveIds.has(conflict.id)).map((conflict) => {
    const local = conflict.themeId === state.activeThemeId;
    const inherited = !local;
    return `<div class="manager-row"><div><strong>${escapeHtml(conflict.name)}</strong><div class="tiny muted">${conflict.implementationIds.length} members · ${conflict.themeId === null ? 'Global' : escapeHtml(themeName(conflict.themeId))}${conflict.overridesConflictId ? ' · Override' : ''}</div>${conflict.detailsHtml ? `<div class="tiny">${escapeHtml(stripHtml(conflict.detailsHtml).slice(0, 150))}</div>` : ''}</div>
      <div class="manager-row-actions">${local ? `<button class="button ghost" data-action="edit-conflict" data-id="${conflict.id}">Edit</button><button class="button danger" data-action="delete-conflict" data-id="${conflict.id}">Delete</button>` : `<button class="button ghost" data-action="override-conflict" data-id="${conflict.id}">Override</button><button class="button ghost" data-action="hide-conflict" data-id="${conflict.id}">Hide here</button>`}</div></div>`;
  }).join('');
  const chain = themeChain(state.themes, state.activeThemeId);
  const hiddenRows = (activeTheme().hiddenInheritedConflictIds || [])
    .map((conflictId) => byId(state.conflicts, conflictId))
    .filter((conflict) => conflict && (conflict.themeId === null || chain.includes(conflict.themeId)))
    .map((conflict) => `<div class="manager-row"><div><strong>${escapeHtml(conflict.name)}</strong><div class="tiny muted">Hidden inherited conflict</div></div><div class="manager-row-actions"><button class="button secondary" data-action="unhide-conflict" data-id="${conflict.id}">Restore</button></div></div>`).join('');
  modalManager(`Conflicts in ${activeTheme().name}`, `<div class="manager-heading"><p class="callout">A conflict set becomes invalid only when every member is locked. Subsets remain valid.</p><button class="button primary" data-action="add-conflict">+ Conflict</button></div><div class="manager-list">${rows || '<p class="muted">No conflicts apply to this theme.</p>'}</div>${hiddenRows ? `<section class="manager-section"><h3>Hidden inherited conflicts</h3><div class="manager-list">${hiddenRows}</div></section>` : ''}`);
}

function captureRichView() {
  return structuredClone(view());
}

function openSaveViewForm() {
  modalForm('Save current selection or view', `
    <div class="form-grid"><label class="field full"><span>Name</span><input name="name" required autofocus placeholder="Exploration A" /></label>
    <label class="field full"><span>Save type</span><select name="kind"><option value="rich" selected>Rich view — locks, visibility, expansion, filters</option><option value="simple">Simple selection — locked implementations only</option></select></label></div>
  `, async (form) => {
    const data = new FormData(form);
    const name = String(data.get('name') || '').trim();
    const kind = String(data.get('kind'));
    if (!name) throw new Error('A name is required.');
    state.savedViews.push({ id: id(), name, kind, themeId: state.activeThemeId, lockedImplementationIds: [...view().lockedImplementationIds], richView: kind === 'rich' ? captureRichView() : null, createdAt: new Date().toISOString() });
    closeModal(); markDirty(); openSavesManager();
  });
}

function openSavesManager() {
  modalManager('Saved selections and views', `<div class="manager-heading"><p class="callout">Rich is the default. Simple saves only the lock set for future lightweight use.</p><button class="button primary" data-action="save-current-view">+ Save current</button></div>
    <div class="manager-list">${state.savedViews.length ? state.savedViews.map((saved) => `<div class="manager-row"><div><strong>${escapeHtml(saved.name)}</strong><div class="tiny muted">${saved.kind === 'rich' ? 'Rich view' : 'Simple selection'} · ${escapeHtml(themeName(saved.themeId))} · ${saved.lockedImplementationIds.length} locked</div></div><div class="manager-row-actions"><button class="button secondary" data-action="load-view" data-id="${saved.id}">Load</button><button class="button danger" data-action="delete-view" data-id="${saved.id}">Delete</button></div></div>`).join('') : '<p class="muted">No saved views yet.</p>'}</div>`);
}

function deleteIdea(ideaId) {
  const idea = byId(state.ideas, ideaId);
  if (!idea || !confirm(`Delete “${idea.title}”? Implementations linked only to this idea will also be deleted.`)) return;
  const orphanIds = state.implementations.filter((implementation) => implementation.ideaIds.length === 1 && implementation.ideaIds[0] === ideaId).map((item) => item.id);
  state.ideas = state.ideas.filter((item) => item.id !== ideaId);
  state.implementations.forEach((implementation) => { implementation.ideaIds = implementation.ideaIds.filter((id) => id !== ideaId); });
  for (const orphanId of orphanIds) removeImplementation(orphanId, false);
  closeModal(); render(); markDirty();
}

function removeImplementation(implementationId, ask = true) {
  const implementation = byId(state.implementations, implementationId);
  if (!implementation || (ask && !confirm(`Delete “${implementation.title}” everywhere?`))) return false;
  state.implementations = state.implementations.filter((item) => item.id !== implementationId);
  state.conflicts = state.conflicts.map((conflict) => ({ ...conflict, implementationIds: conflict.implementationIds.filter((id) => id !== implementationId) })).filter((conflict) => conflict.implementationIds.length >= 2);
  state.savedViews.forEach((saved) => { saved.lockedImplementationIds = saved.lockedImplementationIds.filter((id) => id !== implementationId); if (saved.richView) saved.richView.lockedImplementationIds = saved.richView.lockedImplementationIds.filter((id) => id !== implementationId); });
  Object.values(state.uiByTheme).forEach((item) => {
    for (const key of ['lockedImplementationIds', 'visibleImplementationIds', 'previousVisibleImplementationIds', 'expandedImplementationIds', 'knownImplementationIds']) item[key] = (item[key] || []).filter((id) => id !== implementationId);
  });
  if (currentInspectorId === implementationId) currentInspectorId = null;
  return true;
}

function deleteTheme(themeId) {
  const theme = byId(state.themes, themeId);
  if (!theme) return;
  if (state.themes.length === 1) return showToast('At least one theme is required.');
  if (state.themes.some((item) => item.parentId === themeId)) return showToast('Delete or reparent child themes first.');
  if (!confirm(`Delete theme “${theme.name}”? Direct assignments in this theme will be removed.`)) return;
  state.themes = state.themes.filter((item) => item.id !== themeId);
  const orphanImplementationIds = [];
  state.implementations.forEach((implementation) => {
    implementation.themeIds = implementation.themeIds.filter((id) => id !== themeId);
    if (!implementation.themeIds.length) orphanImplementationIds.push(implementation.id);
  });
  orphanImplementationIds.forEach((id) => removeImplementation(id, false));
  state.conflicts = state.conflicts.filter((conflict) => conflict.themeId !== themeId);
  delete state.uiByTheme[themeId];
  if (state.activeThemeId === themeId) state.activeThemeId = state.themes[0].id;
  render(); markDirty(); openStructureManager();
}

function deleteGroup(kind, groupId) {
  const list = kind === 'idea' ? state.ideaGroups : state.implementationGroups;
  const group = byId(list, groupId);
  if (!group || !confirm(`Delete group “${group.name}”?`)) return;
  if (kind === 'idea') {
    state.ideaGroups = state.ideaGroups.filter((item) => item.id !== groupId);
    state.ideas.forEach((idea) => { idea.groupIds = idea.groupIds.filter((id) => id !== groupId); });
    state.groupLinks = state.groupLinks.filter((link) => link.ideaGroupId !== groupId);
  } else {
    state.implementationGroups = state.implementationGroups.filter((item) => item.id !== groupId);
    state.implementations.forEach((implementation) => { implementation.groupIds = implementation.groupIds.filter((id) => id !== groupId); });
    state.groupLinks = state.groupLinks.filter((link) => link.implementationGroupId !== groupId);
  }
  render(); markDirty(); openStructureManager();
}

function loadSavedView(savedId) {
  const saved = byId(state.savedViews, savedId);
  if (!saved) return;
  state.activeThemeId = saved.themeId;
  if (saved.kind === 'rich' && saved.richView) state.uiByTheme[saved.themeId] = structuredClone(saved.richView);
  else view().lockedImplementationIds = normalizeLocked(conflictsForTheme(), saved.lockedImplementationIds);
  focusedConflictId = null; currentInspectorId = null;
  closeModal(); render(); markDirty();
}

async function uploadAttachment(input) {
  const file = input.files?.[0];
  const implementationId = input.dataset.implementationId;
  if (!file || !implementationId) return;
  try {
    setStatus('Uploading attachment…');
    const attachment = await api(`/api/attachments?filename=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
    const implementation = byId(state.implementations, implementationId);
    implementation.attachments ||= [];
    implementation.attachments.push(attachment);
    render(); markDirty();
  } catch (error) { showToast(error.message); }
}

function handleAction(target) {
  const action = target.dataset.action;
  const itemId = target.dataset.id;
  if (!action) return;
  if (action === 'cycle-color-mode') { cycleColorMode(); return; }
  if (action === 'continue-guest') { continueAsGuest(); return; }
  if (action === 'sign-in') { clerk?.openSignIn({ afterSignInUrl: window.location.href, afterSignUpUrl: window.location.href }); return; }
  if (action === 'sign-out') { clerk?.signOut(() => location.reload()); return; }
  const v = state ? view() : null;
  if (action === 'browse-project') {
    const originalText = target.textContent;
    const gateError = $('#gate-error');
    target.disabled = true;
    target.textContent = 'Opening…';
    gateError.textContent = '';
    const hintTimer = setTimeout(() => {
      gateError.textContent = 'Waiting for the system folder picker — if it does not appear, check the taskbar or enter the path manually below.';
    }, 4000);
    api('/api/project/pick', { method: 'POST' })
      .then((result) => { if (result.path) $('#project-path').value = result.path; })
      .catch((error) => { gateError.textContent = error.message; })
      .finally(() => { clearTimeout(hintTimer); target.disabled = false; target.textContent = originalText; });
  } else if (action === 'open-project') openProjectFromGate();
  else if (action === 'open-included-project') openIncludedProject();
  else if (action === 'close-modal') closeModal();
  else if (action === 'add-idea') { closeModal(); openIdeaForm(); }
  else if (action === 'edit-idea') { closeModal(); openIdeaForm(itemId); }
  else if (action === 'delete-idea') deleteIdea(itemId);
  else if (action === 'add-implementation') { closeModal(); openImplementationForm(null, target.dataset.ideaId || null); }
  else if (action === 'edit-implementation') { closeModal(); openImplementationForm(itemId); }
  else if (action === 'delete-implementation') { if (removeImplementation(itemId)) { render(); markDirty(); } }
  else if (action === 'toggle-idea-details') { v.expandedIdeaIds = v.expandedIdeaIds.includes(itemId) ? v.expandedIdeaIds.filter((id) => id !== itemId) : [...v.expandedIdeaIds, itemId]; render(); markDirty(); }
  else if (action === 'toggle-impl-details') { v.expandedImplementationIds = v.expandedImplementationIds.includes(itemId) ? v.expandedImplementationIds.filter((id) => id !== itemId) : [...v.expandedImplementationIds, itemId]; render(); markDirty(); }
  else if (action === 'hide-implementation') { v.previousVisibleImplementationIds = [...v.visibleImplementationIds]; v.visibleImplementationIds = v.visibleImplementationIds.filter((id) => id !== itemId); render(); markDirty(); }
  else if (action === 'show-implementation') { v.previousVisibleImplementationIds = [...v.visibleImplementationIds]; v.visibleImplementationIds = unique([...v.visibleImplementationIds, itemId]); render(); markDirty(); }
  else if (action === 'show-all') { v.previousVisibleImplementationIds = [...v.visibleImplementationIds]; v.visibleImplementationIds = implementationsForTheme().map((item) => item.id); render(); markDirty(); }
  else if (action === 'hide-all') { v.previousVisibleImplementationIds = [...v.visibleImplementationIds]; v.visibleImplementationIds = []; render(); markDirty(); }
  else if (action === 'restore-visible') { const previous = [...v.previousVisibleImplementationIds]; v.previousVisibleImplementationIds = [...v.visibleImplementationIds]; v.visibleImplementationIds = previous; render(); markDirty(); }
  else if (action === 'toggle-lock') {
    if (v.lockedImplementationIds.includes(itemId)) v.lockedImplementationIds = v.lockedImplementationIds.filter((id) => id !== itemId);
    else if (!blockingConflicts(conflictsForTheme(), v.lockedImplementationIds, itemId).length) v.lockedImplementationIds.push(itemId);
    render(); markDirty();
  }
  else if (action === 'clear-locks') { v.lockedImplementationIds = []; render(); markDirty(); }
  else if (action === 'open-inspector') { currentInspectorId = itemId; renderInspector(); }
  else if (action === 'focus-conflict') { focusedConflictId = itemId; closeModal(); render(); }
  else if (action === 'clear-conflict-focus') { focusedConflictId = null; renderBoard(); }
  else if (action === 'manage-structure') openStructureManager();
  else if (action === 'add-theme-quick') { closeModal(); openThemeForm(null, false); }
  else if (action === 'add-theme') { closeModal(); openThemeForm(); }
  else if (action === 'edit-theme') { closeModal(); openThemeForm(itemId); }
  else if (action === 'delete-theme') deleteTheme(itemId);
  else if (action === 'add-group') { closeModal(); openGroupForm(target.dataset.kind); }
  else if (action === 'edit-group') { closeModal(); openGroupForm(target.dataset.kind, itemId); }
  else if (action === 'delete-group') deleteGroup(target.dataset.kind, itemId);
  else if (action === 'add-group-link') { if (!state.ideaGroups.length || !state.implementationGroups.length) showToast('Create an idea group and an implementation group first.'); else { closeModal(); openGroupLinkForm(); } }
  else if (action === 'edit-group-link') { closeModal(); openGroupLinkForm(itemId); }
  else if (action === 'delete-group-link') { state.groupLinks = state.groupLinks.filter((item) => item.id !== itemId); render(); markDirty(); openStructureManager(); }
  else if (action === 'manage-conflicts') openConflictManager();
  else if (action === 'add-conflict') { closeModal(); openConflictForm(); }
  else if (action === 'edit-conflict') { closeModal(); openConflictForm(itemId); }
  else if (action === 'delete-conflict') { const conflict = byId(state.conflicts, itemId); if (conflict && confirm(`Delete conflict “${conflict.name}”?`)) { state.conflicts = state.conflicts.filter((item) => item.id !== itemId); render(); markDirty(); openConflictManager(); } }
  else if (action === 'override-conflict') { closeModal(); openConflictForm(null, itemId); }
  else if (action === 'hide-conflict') { const theme = activeTheme(); theme.hiddenInheritedConflictIds = unique([...(theme.hiddenInheritedConflictIds || []), itemId]); render(); markDirty(); openConflictManager(); }
  else if (action === 'unhide-conflict') { const theme = activeTheme(); theme.hiddenInheritedConflictIds = (theme.hiddenInheritedConflictIds || []).filter((id) => id !== itemId); render(); markDirty(); openConflictManager(); }
  else if (action === 'hide-inherited') { const theme = activeTheme(); theme.hiddenInheritedImplementationIds = unique([...(theme.hiddenInheritedImplementationIds || []), itemId]); currentInspectorId = null; render(); markDirty(); }
  else if (action === 'unhide-inherited') { const theme = activeTheme(); theme.hiddenInheritedImplementationIds = (theme.hiddenInheritedImplementationIds || []).filter((id) => id !== itemId); render(); markDirty(); openStructureManager(); }
  else if (action === 'make-direct') { const implementation = byId(state.implementations, itemId); implementation.themeIds = unique([...implementation.themeIds, state.activeThemeId]); activeTheme().hiddenInheritedImplementationIds = (activeTheme().hiddenInheritedImplementationIds || []).filter((id) => id !== itemId); render(); markDirty(); }
  else if (action === 'manage-saves') openSavesManager();
  else if (action === 'save-current-view') { closeModal(); openSaveViewForm(); }
  else if (action === 'load-view') loadSavedView(itemId);
  else if (action === 'delete-view') { state.savedViews = state.savedViews.filter((item) => item.id !== itemId); markDirty(); openSavesManager(); }
  else if (action === 'backup') { downloadProjectZip(state); showToast('Portable backup downloaded.'); }
  else if (action === 'export-project-zip') {
    closeModal(); downloadProjectZip(state); showToast('Portable ZIP exported.');
  }
  else if (action === 'export-project-directory') {
    closeModal(); exportProjectDirectory(state).then(() => showToast('Project directory exported.')).catch((error) => showToast(error.message));
  }
  else if (action === 'import-project-portable') {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.zip,.json,application/zip,application/json';
    input.onchange = async () => { const file = input.files?.[0]; if (!file) return; try { state = await importProjectFile(file); closeModal(); render(); markDirty(); showToast(`Imported ${file.name}.`); } catch (error) { showToast(error.message); } };
    input.click();
  }
  else if (action === 'import-project-directory') {
    importProjectDirectory().then((imported) => { state = imported; closeModal(); render(); markDirty(); showToast('Project directory imported.'); }).catch((error) => showToast(error.message));
  }
  else if (action === 'export-project') {
    closeModal();
    const md = generateExportMarkdown(state);
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.meta.name.replace(/[^a-zA-Z0-9 _-]/g, '_')}.md`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Project exported as markdown.');
  }
  else if (action === 'project-menu') {
    modalManager('Project', `<p><strong>${escapeHtml(state.meta.name)}</strong></p><p class="muted">${escapeHtml(projectPath)}</p><div class="manager-list"><button class="button secondary" data-action="export-project-zip">Export portable ZIP</button><button class="button secondary" data-action="export-project-directory">Export project directory</button><button class="button secondary" data-action="import-project-portable">Import project ZIP or JSON</button><button class="button secondary" data-action="import-project-directory">Import project directory</button><button class="button secondary" data-action="export-project">Export as markdown</button><button class="button secondary" data-action="import-project">Import markdown</button><button class="button secondary" data-action="rename-project">Rename project</button><button class="button secondary" data-action="backup">Create backup now</button><button class="button danger" data-action="close-project">Close project</button></div>`);
  }
  else if (action === 'import-project') {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.md,text/markdown';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        parseImportMarkdown(text, state);
        closeModal();
        render();
        markDirty();
        showToast(`Imported ${file.name}.`);
      } catch (error) {
        showToast(error.message);
      }
    };
    input.click();
  }
  else if (action === 'rename-project') {
    const next = prompt('Project name', state.meta.name);
    if (next?.trim()) { state.meta.name = next.trim(); closeModal(); render(); markDirty(); }
  }
  else if (action === 'close-project') {
    if (confirm('Close this project? Unsaved changes will be saved first.')) {
      saveState().finally(() => location.reload());
    }
  }
  else if (action === 'delete-attachment') {
    const implementation = byId(state.implementations, itemId);
    const storage = target.dataset.storage;
    if (implementation && storage && confirm('Remove this attachment?')) {
      api(`/api/attachments/${encodeURIComponent(storage)}`, { method: 'DELETE' }).then(() => {
        implementation.attachments = (implementation.attachments || []).filter((item) => item.storageName !== storage);
        render(); markDirty();
      }).catch((error) => showToast(error.message));
    }
  }
}

document.addEventListener('click', (event) => {
  const richButton = event.target.closest('[data-rich-cmd]');
  if (richButton) {
    event.preventDefault();
    const shell = richButton.closest('.rich-editor-shell');
    const editor = $('[data-rich-editor]', shell);
    editor.focus();
    document.execCommand(richButton.dataset.richCmd, false, richButton.dataset.richValue || null);
    return;
  }
  const actionTarget = event.target.closest('[data-action]');
  if (actionTarget) {
    handleAction(actionTarget);
    return;
  }
  if (currentInspectorId && !event.target.closest('#inspector') && !event.target.closest('.impl-row') && !event.target.closest('#modal')) {
    currentInspectorId = null;
    renderInspector();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.ctrlKey && event.key === 'Enter') {
    const inspectorForm = $('#inspector-form');
    const modalForm = modal.querySelector('form');
    if (inspectorForm && inspectorForm.contains(event.target)) {
      event.preventDefault();
      const implementation = byId(state.implementations, currentInspectorId);
      if (!implementation) return;
      const formData = new FormData(inspectorForm);
      implementation.title = String(formData.get('title') || '').trim() || implementation.title;
      implementation.detailsHtml = getRichValue($('#inspector'));
      render(); markDirty();
    } else if (modalForm && modalForm.contains(event.target) && modalSubmitHandler) {
      event.preventDefault();
      modalForm.requestSubmit();
    }
  }
});

modal.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!modalSubmitHandler) return;
  try { await modalSubmitHandler(event.target); }
  catch (error) { showToast(error.message); }
});

$('#theme-select').addEventListener('change', (event) => {
  state.activeThemeId = event.target.value;
  currentInspectorId = null; focusedConflictId = null;
  render(); markDirty();
});
$('#search-input').addEventListener('input', (event) => { view().search = event.target.value; renderBoard(); markDirty(); });
$('#idea-group-filter').addEventListener('change', (event) => { view().ideaGroupFilter = event.target.value; renderBoard(); markDirty(); });
$('#show-excluded').addEventListener('change', (event) => { view().showExcluded = event.target.checked; renderBoard(); markDirty(); });
$('#inspector').addEventListener('submit', (event) => {
  if (event.target.id !== 'inspector-form') return;
  event.preventDefault();
  const implementation = byId(state.implementations, currentInspectorId);
  const formData = new FormData(event.target);
  implementation.title = String(formData.get('title') || '').trim() || implementation.title;
  implementation.detailsHtml = getRichValue($('#inspector'));
  render(); markDirty();
});
$('#inspector').addEventListener('change', (event) => { if (event.target.id === 'attachment-input') uploadAttachment(event.target); });
modal.addEventListener('cancel', (event) => { event.preventDefault(); closeModal(); });
window.addEventListener('beforeunload', () => { if (storageMode === 'guest' && state) saveGuestState(state); });

boot();
