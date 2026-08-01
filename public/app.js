import {
  blendBackground,
  blockingConflicts,
  effectiveConflicts,
  lockWithRequirements,
  effectiveImplementations,
  normalizeLockedWithRequirements,
  readableTextColor,
  themeChain,
} from './core.mjs';
import { modeGlyph, modeLabel, nextMode, normalizeMode, resolveThemeMode } from './theme-mode.mjs';
import { generateExportMarkdown, parseImportMarkdown, htmlToMarkdown } from './export.mjs';
import { downloadProjectZip, exportProjectDirectory, importProjectDirectory, importProjectFile, importedAttachments } from './portable.mjs';
import { ideaOrder, implementationOrder, implementationOrderForIdea } from './reorder.mjs';
import { allPairs, fuzzyMatches, requirementEdges, validRequirementChains } from './relationships.mjs';
import { validateProjectDocument, projectContentFingerprint, projectDocumentForPersistence } from '../src/shared/project-document.mjs';
import { SaveCoordinator } from './save-coordinator.mjs';
import { createDraftJournal } from './draft-journal.mjs';
import { storeGuestAttachment, hydrateGuestAttachments, deleteGuestAttachment } from './guest-attachments.mjs';
import { markdownToSafeHtml, detailsText } from './markdown.mjs';
import { boardControlsHtml } from './board-controls.mjs';
import { posthogReady } from './posthog.mjs';

posthogReady.catch((error) => console.error(error));

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
let currentInspectorIdeaId = null;
let focusedConflictId = null;
let saveTimer = null;
let modalSubmitHandler = null;
let lastSavedSnapshot = '';
let includedProjects = [];
let storageMode = null;
let clerk = null;
let clerkStatus = 'idle';
let clerkInitialization = null;
let guestState = null;
let cloudWorkspaceReady = false;
let authenticationError = '';
let pendingCloudConflict = null;
let activeDrag = null;
let relationshipDraft = null;
let requirementBuilder = null;
let modalCloseReturn = null;
let modalDirty = false;
let currentProjectId = 'guest';
let currentRevision = 0;
let saveCoordinator = null;
let pendingSaveConflict = null;
let pendingRecoveredDraft = null;
let undoStack = [];
let redoStack = [];
let historyBaseline = '';
let historyCoalesceTimer = null;
let selfHosted = false;
let boardDensity = localStorage.getItem('ideation-workbench:board-density') === 'compact' ? 'compact' : 'detailed';
const GUEST_STORAGE_KEY = 'ideation-workbench:guest-state:v1';
const GUEST_BACKUP_KEY = 'ideation-workbench:guest-backup-before-cloud:v1';

function guestDefaultState(name = 'My Ideation Project') {
  const themeId = id();
  const stamp = new Date().toISOString();
  return { version: 2, meta: { id: id(), name, createdAt: stamp, updatedAt: stamp }, displaySettings: { ideaTitleSize: 18, ideaDetailsSize: 14, implementationTitleSize: 14, implementationDetailsSize: 13 }, themes: [{ id: themeId, name: 'Core', parentId: null, hiddenInheritedImplementationIds: [], hiddenInheritedConflictIds: [] }], ideaGroups: [], implementationGroups: [], ideas: [], implementations: [], groupLinks: [], conflicts: [], requirements: [], savedViews: [], uiByTheme: { [themeId]: defaultView() }, activeThemeId: themeId };
}

function readGuestState() {
  try { return JSON.parse(localStorage.getItem(GUEST_STORAGE_KEY) || 'null') || guestDefaultState(); }
  catch { return guestDefaultState(); }
}

function saveGuestState(next) {
  guestState = projectDocumentForPersistence(next);
  localStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify(guestState));
  return guestState;
}

function guestHasWork(candidate) {
  if (!candidate) return false;
  return Boolean(candidate.ideas?.length || candidate.implementations?.length || candidate.ideaGroups?.length || candidate.implementationGroups?.length || candidate.conflicts?.length || candidate.savedViews?.length || candidate.themes?.length > 1);
}

function renderStorageNotice() {
  const notice = $('#storage-note');
  if (!notice) return;
  if (storageMode === 'cloud') {
    notice.textContent = 'Saved to your private account.';
    return;
  }
  if (pendingCloudConflict) {
    notice.innerHTML = 'This browser project has not been uploaded. <button class="link-button" data-action="resolve-cloud-conflict">Choose where to save it</button>';
    return;
  }
  if (clerk?.user) {
    notice.innerHTML = 'Signed in, but this browser project is not connected to cloud storage yet. <button class="link-button" data-action="retry-cloud-connection">Connect it now</button>';
    return;
  }
  notice.innerHTML = 'Saved only in this browser. <button class="link-button" data-action="sign-in">Get an account to keep it across devices</button>';
}

async function api(path, options = {}) {
  if (storageMode === 'guest') {
    if (path === '/api/status') return { authenticated: false, provisioned: false, open: true, path: 'This browser (not uploaded)', projectId: guestState?.meta?.id || 'guest', revision: currentRevision, state: structuredClone(guestState) };
    if (path === '/api/state' && (!options.method || options.method === 'GET')) return structuredClone(guestState);
    if (path === '/api/state' && options.method === 'PUT') {
      const body = JSON.parse(options.body);
      const next = body?.state || body;
      return { state: saveGuestState(validateProjectDocument(next)), revision: currentRevision += 1 };
    }
    if (path.startsWith('/api/attachments') && options.method === 'POST') {
      const filename = new URL(path, location.origin).searchParams.get('filename') || options.body?.name || 'attachment.bin';
      return storeGuestAttachment(currentProjectId, options.body, { name: filename });
    }
    if (path.startsWith('/api/attachments/') && options.method === 'DELETE') {
      await deleteGuestAttachment(decodeURIComponent(path.slice('/api/attachments/'.length)));
      return { ok: true };
    }
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
  if (!response.ok) {
    const cause = new Error(payload?.error || payload || `Request failed: ${response.status}`);
    cause.status = response.status;
    cause.payload = payload;
    throw cause;
  }
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

function id() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function byId(list, itemId) { return list.find((item) => item.id === itemId); }
function unique(values) { return [...new Set(values)]; }
function numberSort(a, b) { return (a.sortOrder || 0) - (b.sortOrder || 0) || a.title.localeCompare(b.title); }
function themeName(themeId) { return byId(state.themes, themeId)?.name || 'Unknown theme'; }
function activeTheme() { return byId(state.themes, state.activeThemeId); }
function conflictsForTheme() { return effectiveConflicts(state, state.activeThemeId); }
function implementationsForTheme() { return effectiveImplementations(state, state.activeThemeId); }
function requirements() { return state.requirements ||= []; }

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 2600);
}

function setStatus(message) { $('#save-status').textContent = message; }

async function captureEvent(event, properties = {}) {
  try {
    const posthog = await posthogReady;
    posthog?.capture(event, properties);
  } catch (error) {
    console.error(error);
  }
}

function defaultView() {
  return {
    lockedImplementationIds: [], visibleImplementationIds: [], previousVisibleImplementationIds: [],
    manuallyLockedImplementationIds: [], selectedImplementationIds: [],
    expandedIdeaIds: [], expandedImplementationIds: [], showExcluded: true, search: '', ideaGroupFilterIds: [],
    knownImplementationIds: [], ideaSort: 'manual', ideaSortDirection: 'asc',
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
  if (!Array.isArray(target.manuallyLockedImplementationIds)) target.manuallyLockedImplementationIds = [...(target.lockedImplementationIds || [])];
  target.manuallyLockedImplementationIds = target.manuallyLockedImplementationIds.filter((itemId) => effectiveSet.has(itemId));
  target.lockedImplementationIds = normalizeLockedWithRequirements(conflictsForTheme(), requirements(), target.manuallyLockedImplementationIds, effectiveIds);
  target.selectedImplementationIds = (target.selectedImplementationIds || []).filter((itemId) => effectiveSet.has(itemId));
  if (!Array.isArray(target.ideaGroupFilterIds)) target.ideaGroupFilterIds = target.ideaGroupFilter && target.ideaGroupFilter !== 'all' ? [target.ideaGroupFilter] : [];
  target.expandedImplementationIds = (target.expandedImplementationIds || []).filter((itemId) => effectiveSet.has(itemId));
  target.knownImplementationIds = effectiveIds;
}

function markDirty(recordHistory = true) {
  if (!state) return;
  const current = JSON.stringify(state);
  if (recordHistory && historyBaseline && current !== historyBaseline) {
    if (!historyCoalesceTimer) undoStack.push(JSON.parse(historyBaseline));
    undoStack = undoStack.slice(-100);
    redoStack = [];
    clearTimeout(historyCoalesceTimer);
    historyCoalesceTimer = setTimeout(() => { historyCoalesceTimer = null; historyBaseline = JSON.stringify(state); }, 700);
  }
  historyBaseline = current;
  setStatus('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 450);
}

async function saveState() {
  if (!state) return;
  const snapshot = projectDocumentForPersistence(state);
  if (projectContentFingerprint(snapshot) === lastSavedSnapshot) { setStatus('Saved'); return; }
  await saveCoordinator?.enqueue(snapshot);
}

function downloadStateCopy(snapshot, suffix = 'local-copy') {
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${state.meta.name.replace(/[^a-zA-Z0-9 _-]/g, '_')}-${suffix}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function configureSaveCoordinator() {
  const journal = createDraftJournal(`${storageMode}:${currentProjectId}`);
  const savePath = storageMode === 'cloud' ? `/api/projects/${encodeURIComponent(currentProjectId)}/state` : '/api/state';
  saveCoordinator = new SaveCoordinator({
    journal,
    save: async (snapshot) => api(savePath, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: snapshot, baseRevision: currentRevision }),
    }),
    onStatus(status) {
      if (status === 'saving' || status === 'queued') setStatus('Savingâ€¦');
      if (status === 'offline') setStatus('Offline â€” changes queued');
      if (status === 'conflict') setStatus('Save conflict');
    },
    onSaved(result, snapshot) {
      currentRevision = Number(result.revision || currentRevision + 1);
      lastSavedSnapshot = projectContentFingerprint(result.state || snapshot);
      if (projectContentFingerprint(state) === projectContentFingerprint(snapshot) && result.state?.meta?.updatedAt) state.meta.updatedAt = result.state.meta.updatedAt;
      setStatus(`Saved ${new Date(result.state?.meta?.updatedAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    },
    onConflict(error, snapshot) {
      pendingSaveConflict = { error, snapshot, server: error.payload?.state || null };
      modalManager('Changes need review', `<p>This project changed somewhere else while you were editing. Your local draft is safe.</p><div class="manager-list"><button class="button secondary" data-action="download-conflict-copy">Download my local copy</button>${pendingSaveConflict.server ? '<button class="button secondary" data-action="use-server-copy">Reload the saved copy</button>' : ''}<button class="button danger" data-action="force-save-local">Replace the saved copy with mine</button><button class="button ghost" data-action="close-modal">Decide later</button></div>`);
    },
  });
  journal.read().then((draft) => {
    if (!draft || projectContentFingerprint(draft) === projectContentFingerprint(state)) return;
    pendingRecoveredDraft = draft;
    modalManager('Unsaved draft recovered', '<p>This browser contains changes that were not confirmed by storage.</p><div class="manager-list"><button class="button primary" data-action="restore-draft">Restore the draft</button><button class="button secondary" data-action="download-recovered-draft">Download it first</button><button class="button ghost" data-action="discard-recovered-draft">Discard it</button></div>');
  });
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

function themePath(themeId) {
  const names = [];
  let theme = byId(state.themes, themeId);
  const seen = new Set();
  while (theme && !seen.has(theme.id)) { names.unshift(theme.name); seen.add(theme.id); theme = byId(state.themes, theme.parentId); }
  return names.join(' / ');
}

function checkboxGrid(name, items, selected = [], labeler = (item) => item.name || item.title || 'Untitled group') {
  const selectedSet = new Set(selected);
  if (!items.length) return '<p class="muted">Nothing available yet.</p>';
  return `<div class="checkbox-grid">${items.map((item) => `
    <label class="checkbox-item"><input type="checkbox" name="${name}" value="${item.id}" ${selectedSet.has(item.id) ? 'checked' : ''} /><span>${escapeHtml(labeler(item))}</span></label>
  `).join('')}</div>`;
}

function richEditor(value = '', placeholder = 'Add details…') {
  return `<div class="markdown-editor-shell"><textarea class="markdown-editor" data-details-editor rows="8" placeholder="${escapeHtml(placeholder)}" aria-label="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea><p class="tiny muted">Markdown supported: **bold**, *italic*, lists, quotes, links, and code.</p></div>`;
}

function modalForm(title, body, onSubmit, submitLabel = 'Save') {
  modalTitle.textContent = title;
  modalBody.innerHTML = `<form id="modal-form">${body}<div class="form-actions"><button type="button" class="button ghost" data-action="close-modal">Cancel</button><button type="submit" class="button primary">${escapeHtml(submitLabel)}</button></div></form>`;
  modalSubmitHandler = onSubmit;
  modalDirty = false;
  modal.showModal();
}

function modalManager(title, body) {
  modalTitle.textContent = title;
  modalBody.innerHTML = body;
  modalSubmitHandler = null;
  modalDirty = false;
  modal.showModal();
}

function closeModal() {
  modal.close();
  modalBody.innerHTML = '';
  modalSubmitHandler = null;
  modalCloseReturn = null;
  modalDirty = false;
}

function modalHasDiscardableWork() {
  if (modalDirty) return true;
  if (modalCloseReturn) return false;
  if (relationshipDraft?.screen === 'conflict' && (relationshipDraft.picked.length || relationshipDraft.conflictMembers.length)) return true;
  return Boolean(requirementBuilder && (requirementBuilder.picked.length || requirementBuilder.sides.some((side) => side.length)));
}

function dismissModal() {
  if (modalHasDiscardableWork() && !confirm('Discard the unfinished relationship changes?')) return;
  const returnTo = modalCloseReturn;
  closeModal();
  if (returnTo) returnTo();
}

function getRichValue(root = modalBody) {
  return String($('[data-details-editor]', root)?.value || '').trim();
}

function renderThemePicker() {
  const name = activeTheme()?.name || 'Choose theme';
  $('#active-theme-label').textContent = name;
  $('#theme-picker-button').title = `Choose theme: ${name}`;
}

function openThemePicker() {
  const children = new Map();
  for (const theme of state.themes) {
    const parent = theme.parentId || '__root__';
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(theme);
  }
  for (const list of children.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  const rows = [];
  const walk = (parentId, depth) => {
    for (const theme of children.get(parentId) || []) {
      const prefix = depth ? `${'— '.repeat(depth)}` : '';
      rows.push(`<button class="manager-row theme-choice ${theme.id === state.activeThemeId ? 'selected-theme' : ''}" data-action="select-theme" data-id="${theme.id}"><span>${escapeHtml(prefix + theme.name)}</span><span class="tiny muted">${escapeHtml(themePath(theme.id))}</span></button>`);
      walk(theme.id, depth + 1);
    }
  };
  walk('__root__', 0);
  modalManager('Choose theme', `<div class="manager-list">${rows.join('')}</div><div class="form-actions"><button class="button secondary" data-action="add-theme">+ New theme</button><button class="button ghost" data-action="close-modal">Close</button></div>`);
}

function openCreateMenu() {
  modalManager('Create', `<div class="manager-list create-menu"><button class="button primary" data-action="create-idea">Idea</button><button class="button primary" data-action="create-implementation">Implementation</button><button class="button secondary" data-action="create-theme">Theme</button><button class="button secondary" data-action="create-idea-group">Idea group</button><button class="button secondary" data-action="create-implementation-group">Implementation group</button><button class="button ghost" data-action="open-empty-relationship-flow">Conflict / requirement</button></div>`);
}

function openCommandPalette() {
  modalManager('Commands', `<label class="field"><span>Find a command</span><input data-command-search type="search" placeholder="Create, share, import…" autofocus /></label><div class="manager-list command-list"><button class="button primary" data-action="add-idea">Create idea</button><button class="button primary" data-action="create-implementation">Create implementation</button><button class="button secondary" data-action="manage-structure">Open structure</button><button class="button secondary" data-action="manage-saves">Open saved views</button><button class="button secondary" data-action="open-share-menu">Manage shares</button><button class="button secondary" data-action="open-project-library">Open project library</button><button class="button secondary" data-action="open-export-menu">Export project</button><button class="button secondary" data-action="open-import-menu">Import project</button><button class="button ghost" data-action="toggle-board-density">Toggle board density</button></div>`);
}

function openMoreMenu() {
  modalManager('More', `<div class="form-actions"><button class="button ghost compact" data-action="undo" ${undoStack.length ? '' : 'disabled'}>Undo</button><button class="button ghost compact" data-action="redo" ${redoStack.length ? '' : 'disabled'}>Redo</button></div><div class="manager-list"><button class="button secondary" data-action="open-command-palette">Commands <span class="tiny muted">Ctrl/⌘ K</span></button><button class="button secondary" data-action="open-display-settings">Display and sorting</button><button class="button secondary" data-action="toggle-board-density">Board density: ${boardDensity === 'compact' ? 'Compact' : 'Detailed'}</button><button class="button secondary" data-action="manage-structure">Structure</button><button class="button secondary" data-action="manage-saves">Saved views</button><button class="button secondary" data-action="open-mobile-filters">Filters and visibility</button><button class="button secondary" data-action="open-share-menu">Share</button><button class="button secondary" data-action="open-export-menu">Export</button><button class="button secondary" data-action="open-import-menu">Import</button><button class="button ghost" data-action="project-menu">Project settings</button></div>`);
  if (state.savedViews.length >= 2) {
    const compare = document.createElement('button');
    compare.className = 'button secondary';
    compare.dataset.action = 'compare-views';
    compare.textContent = 'Compare saved views';
    $('.manager-list', modalBody)?.insertBefore(compare, $('.manager-list [data-action="open-mobile-filters"]', modalBody));
  }
}

function openDisplaySettings() {
  const settings = state.displaySettings || { ideaTitleSize: 18, ideaDetailsSize: 14, implementationTitleSize: 14, implementationDetailsSize: 13 };
  const v = view();
  modalForm('Display and sorting', `<div class="form-grid"><label class="field"><span>Idea title size</span><input name="ideaTitleSize" type="number" min="12" max="32" value="${settings.ideaTitleSize}" /></label><label class="field"><span>Idea details size</span><input name="ideaDetailsSize" type="number" min="10" max="24" value="${settings.ideaDetailsSize}" /></label><label class="field"><span>Implementation title size</span><input name="implementationTitleSize" type="number" min="10" max="28" value="${settings.implementationTitleSize}" /></label><label class="field"><span>Implementation details size</span><input name="implementationDetailsSize" type="number" min="10" max="22" value="${settings.implementationDetailsSize}" /></label><label class="field"><span>Sort ideas</span><select name="ideaSort"><option value="manual" ${v.ideaSort === 'manual' ? 'selected' : ''}>Manual order</option><option value="implementations" ${v.ideaSort === 'implementations' ? 'selected' : ''}>Implementation count</option><option value="locked" ${v.ideaSort === 'locked' ? 'selected' : ''}>Locked count</option><option value="conflicts" ${v.ideaSort === 'conflicts' ? 'selected' : ''}>Conflict count</option></select></label><label class="field"><span>Direction</span><select name="ideaSortDirection"><option value="asc" ${v.ideaSortDirection === 'asc' ? 'selected' : ''}>Ascending</option><option value="desc" ${v.ideaSortDirection === 'desc' ? 'selected' : ''}>Descending</option></select></label></div>`, async (form) => {
    const data = new FormData(form); const clamp = (name, min, max, fallback) => Math.min(max, Math.max(min, Number(data.get(name)) || fallback));
    state.displaySettings = { ideaTitleSize: clamp('ideaTitleSize', 12, 32, 18), ideaDetailsSize: clamp('ideaDetailsSize', 10, 24, 14), implementationTitleSize: clamp('implementationTitleSize', 10, 28, 14), implementationDetailsSize: clamp('implementationDetailsSize', 10, 22, 13) };
    v.ideaSort = String(data.get('ideaSort')); v.ideaSortDirection = String(data.get('ideaSortDirection'));
    closeModal(); render(); markDirty();
  });
}

function openMobileFilters() {
  const v = view();
  const groups = state.ideaGroups.map((group) => `<label class="checkbox-item"><input type="checkbox" data-mobile-group-filter value="${group.id}" ${v.ideaGroupFilterIds.includes(group.id) ? 'checked' : ''}><span>${escapeHtml(group.name || 'Untitled group')}</span></label>`).join('');
  modalManager('Filters and visibility', `<label class="toggle-label"><input type="checkbox" data-mobile-show-excluded ${v.showExcluded ? 'checked' : ''}> Show excluded choices</label><div class="form-actions"><button class="button secondary" data-action="show-all">Show all</button><button class="button secondary" data-action="hide-all">Hide all</button><button class="button ghost" data-action="restore-visible">Restore previous</button></div><h3>Idea groups</h3><div class="checkbox-grid"><label class="checkbox-item"><input type="checkbox" data-mobile-group-filter value="__ungrouped__" ${v.ideaGroupFilterIds.includes('__ungrouped__') ? 'checked' : ''}><span>Ungrouped</span></label>${groups}</div><div class="form-actions"><button class="button ghost" data-action="clear-mobile-filters">Clear groups</button><button class="button primary" data-action="apply-mobile-filters">Apply</button></div>`);
  const sort = document.createElement('label');
  sort.className = 'field';
  sort.innerHTML = `<span>Sort ideas</span><select data-mobile-idea-sort><option value="manual">Manual</option><option value="implementations">Implementation count</option><option value="locked">Locked count</option><option value="conflicts">Conflict count</option></select>`;
  sort.querySelector('select').value = v.ideaSort;
  modalBody.querySelector('.form-actions')?.before(sort);
}

function renderFilters() {
  const v = view();
  $('#board-controls').innerHTML = boardControlsHtml({ view: v, groups: state.ideaGroups, include: { fontSettings: true, lockSummary: true } });
  const selectedControl = v.selectedImplementationIds.filter((id) => byId(state.implementations, id));
  const lockSelectedControl = $('#lock-selected');
  if (lockSelectedControl) {
    lockSelectedControl.hidden = !selectedControl.length;
    const allManual = selectedControl.every((id) => v.manuallyLockedImplementationIds.includes(id));
    const conflicts = conflictsForTheme().filter((conflict) => selectedControl.some((id) => conflict.implementationIds.includes(id))).map((conflict) => conflict.name).slice(0, 3);
    const required = requirements().filter((item) => selectedControl.includes(item.fromImplementationId)).map((item) => `${byId(state.implementations, item.fromImplementationId)?.title || 'Implementation'} → ${byId(state.implementations, item.toImplementationId)?.title || 'implementation'}`).slice(0, 3);
    lockSelectedControl.textContent = `${allManual ? 'Unlock' : 'Lock'} selected (${selectedControl.length})`;
    lockSelectedControl.title = `${allManual ? 'Unlock selected implementations' : 'Lock selected implementations and their requirements'}${conflicts.length ? `\nConflicts: ${conflicts.join(', ')}` : ''}${required.length ? `\nRequirements: ${required.join(', ')}` : ''}`;
  }
  $('#relationship-button').hidden = selectedControl.length < 2;
  return;
  $('#search-input').value = v.search;
  $('#show-excluded').checked = v.showExcluded;
  $('#idea-sort').value = v.ideaSort;
  const sortDirection = $('#idea-sort-direction');
  sortDirection.textContent = v.ideaSortDirection === 'desc' ? '↓' : '↑';
  sortDirection.title = `Sort ${v.ideaSortDirection === 'desc' ? 'descending' : 'ascending'}`;
  const selectedGroups = new Set(v.ideaGroupFilterIds);
  const groupLabel = !selectedGroups.size ? 'All groups' : selectedGroups.size === 1 && selectedGroups.has('__ungrouped__') ? 'Ungrouped' : `${selectedGroups.size} group${selectedGroups.size === 1 ? '' : 's'}`;
  $('#idea-group-filter-label').textContent = groupLabel;
  $('#idea-group-filter-options').innerHTML = `<div class="group-filter-row"><button data-action="filter-idea-group-only" data-id="all">All groups</button></div><div class="group-filter-row"><button data-action="filter-idea-group-only" data-id="__ungrouped__">Ungrouped</button><button class="group-filter-toggle ${selectedGroups.has('__ungrouped__') ? 'active' : ''}" data-action="toggle-idea-group-filter" data-id="__ungrouped__" aria-label="Toggle ungrouped">${selectedGroups.has('__ungrouped__') ? '✓' : '+'}</button></div>${state.ideaGroups.map((group) => `<div class="group-filter-row"><button data-action="filter-idea-group-only" data-id="${group.id}">${escapeHtml(group.name || 'Untitled group')}</button><button class="group-filter-toggle ${selectedGroups.has(group.id) ? 'active' : ''}" data-action="toggle-idea-group-filter" data-id="${group.id}" aria-label="Toggle ${escapeHtml(group.name || 'group')}">${selectedGroups.has(group.id) ? '✓' : '+'}</button></div>`).join('')}`;
  $('#lock-count').textContent = `${v.lockedImplementationIds.length} locked`;
  const selected = v.selectedImplementationIds.filter((id) => byId(state.implementations, id));
  const lockSelected = $('#lock-selected');
  if (lockSelected) {
    lockSelected.hidden = !selected.length;
    const allManual = selected.every((id) => v.manuallyLockedImplementationIds.includes(id));
    const conflicts = conflictsForTheme().filter((conflict) => selected.some((id) => conflict.implementationIds.includes(id))).map((conflict) => conflict.name).slice(0, 3);
    const required = requirements().filter((item) => selected.includes(item.fromImplementationId)).map((item) => `${byId(state.implementations, item.fromImplementationId)?.title || 'Implementation'} → ${byId(state.implementations, item.toImplementationId)?.title || 'implementation'}`).slice(0, 3);
    lockSelected.textContent = `${allManual ? 'Unlock' : 'Lock'} selected (${selected.length})`;
    lockSelected.title = `${allManual ? 'Unlock selected implementations' : 'Lock selected implementations and their requirements'}${conflicts.length ? `\nConflicts: ${conflicts.join(', ')}` : ''}${required.length ? `\nRequirements: ${required.join(', ')}` : ''}`;
  }
  const relationshipButton = $('#relationship-button');
  if (relationshipButton) relationshipButton.hidden = selected.length < 2;
}

function ideaCardStyle(idea) {
  const colors = idea.groupIds.map((groupId) => byId(state.ideaGroups, groupId)?.color).filter(Boolean);
  return `--idea-bg:${blendBackground(colors)};--idea-fg:${readableTextColor(colors)};`;
}

function implementationBadges(implementation, blockers, conflicts, directInTheme) {
  const badges = [];
  const outgoing = requirements().filter((requirement) => requirement.fromImplementationId === implementation.id);
  const incoming = requirements().filter((requirement) => requirement.toImplementationId === implementation.id);
  if (!directInTheme) badges.push(`<span class="micro-badge">Inherited</span>`);
  if (outgoing.length) badges.push(`<span class="micro-badge">Requires ${outgoing.length}</span>`);
  if (incoming.length) badges.push(`<span class="micro-badge">Required by ${incoming.length}</span>`);
  if (blockers.length) badges.push(`<span class="micro-badge warning">${blockers.length} blocking conflict${blockers.length === 1 ? '' : 's'}</span>`);
  for (const conflict of conflicts.slice(0, 3)) badges.push(`<button class="micro-badge conflict" data-action="focus-conflict" data-id="${conflict.id}" title="${escapeHtml(conflict.name)}">${escapeHtml(conflict.name)}</button>`);
  if (conflicts.length > 3) badges.push(`<span class="micro-badge">+${conflicts.length - 3}</span>`);
  return badges.join('');
}

function renderImplementationRow(implementation, allConflicts, v) {
  const locked = v.lockedImplementationIds.includes(implementation.id);
  const proposal = locked ? null : lockWithRequirements(allConflicts, requirements(), v.lockedImplementationIds, implementation.id, implementationsForTheme().map((item) => item.id));
  const blockers = locked ? [] : unique([...blockingConflicts(allConflicts, v.lockedImplementationIds, implementation.id), ...(proposal?.completedConflicts || [])]);
  const missingRequirements = proposal?.missingIds || [];
  const cannotLock = Boolean(blockers.length || missingRequirements.length);
  if (blockers.length && !v.showExcluded) return '';
  const relatedConflicts = allConflicts.filter((conflict) => conflict.implementationIds.includes(implementation.id));
  const expanded = v.expandedImplementationIds.includes(implementation.id);
  const selected = v.selectedImplementationIds.includes(implementation.id);
  const relationKinds = v.selectedImplementationIds.filter((id) => id !== implementation.id).map((selectedId) => {
    const conflict = allConflicts.some((item) => item.implementationIds.includes(selectedId) && item.implementationIds.includes(implementation.id));
    const requires = requirements().some((item) => item.fromImplementationId === selectedId && item.toImplementationId === implementation.id);
    const requiredBy = requirements().some((item) => item.fromImplementationId === implementation.id && item.toImplementationId === selectedId);
    return conflict ? 'relationship-conflict' : requires && requiredBy ? 'relationship-bidirectional' : requires ? 'relationship-requires' : requiredBy ? 'relationship-required-by' : '';
  }).filter(Boolean);
  const relationClass = relationKinds.includes('relationship-conflict') ? 'relationship-conflict' : relationKinds.includes('relationship-bidirectional') ? 'relationship-bidirectional' : relationKinds.includes('relationship-requires') ? 'relationship-requires' : relationKinds.includes('relationship-required-by') ? 'relationship-required-by' : '';
  const focused = focusedConflictId ? byId(allConflicts, focusedConflictId) : null;
  const focusClass = focusedConflictId ? (focused?.implementationIds.includes(implementation.id) ? 'conflict-member' : 'conflict-muted') : '';
  return `<article class="impl-row ${locked ? 'locked' : ''} ${selected ? 'selected' : ''} ${relationClass} ${blockers.length ? 'incompatible' : ''} ${focusClass}" data-implementation-id="${implementation.id}">
    <div class="impl-main">
      <button class="impl-title-button" data-action="open-inspector" data-id="${implementation.id}">${escapeHtml(implementation.title)}</button>
      <div class="impl-subline">${implementationBadges(implementation, blockers, relatedConflicts, implementation.directInTheme)}</div>
    </div>
    <div class="impl-actions">
      <button class="drag-handle" data-reorder-kind="implementation" data-reorder-id="${implementation.id}" aria-label="Reorder implementation ${escapeHtml(implementation.title)}. Use the arrow keys." title="Drag or use arrow keys to reorder">⠿</button>
      <button class="lock-button ${selected ? 'active' : ''}" data-action="toggle-selection" data-id="${implementation.id}" title="${selected ? 'Deselect' : 'Select'}">${selected ? '✓' : '○'}</button>
      <button data-action="toggle-impl-details" data-id="${implementation.id}" title="Toggle details">${expanded ? '▴' : '▾'}</button>
      <button data-action="hide-implementation" data-id="${implementation.id}" title="Hide in this view">◉</button>
    </div>
    ${expanded && detailsText(implementation) ? `<div class="impl-details">${markdownToSafeHtml(detailsText(implementation))}</div>` : ''}
  </article>`;
}

function renderBoard() {
  const board = $('#board');
  board.classList.toggle('compact-density', boardDensity === 'compact');
  const v = view();
  const display = state.displaySettings || {};
  board.style.setProperty('--idea-title-size', `${display.ideaTitleSize || 18}px`);
  board.style.setProperty('--idea-details-size', `${display.ideaDetailsSize || 14}px`);
  board.style.setProperty('--implementation-title-size', `${display.implementationTitleSize || 14}px`);
  board.style.setProperty('--implementation-details-size', `${display.implementationDetailsSize || 13}px`);
  const effective = implementationsForTheme();
  const effectiveById = new Map(effective.map((item) => [item.id, item]));
  const allConflicts = conflictsForTheme();
  const visible = new Set(v.visibleImplementationIds);
  const search = v.search.trim().toLowerCase();
  const selectedGroups = new Set(v.ideaGroupFilterIds || []);
  const ideas = state.ideas
    .filter((idea) => !selectedGroups.size || (selectedGroups.has('__ungrouped__') && !idea.groupIds.length) || idea.groupIds.some((id) => selectedGroups.has(id)))
    .filter((idea) => {
      if (!search) return true;
      const linked = effective.filter((implementation) => implementation.ideaIds.includes(idea.id));
      const linkedIds = new Set(linked.map((implementation) => implementation.id));
      const groupNames = [
        ...idea.groupIds.map((groupId) => byId(state.ideaGroups, groupId)?.name),
        ...linked.flatMap((implementation) => implementation.groupIds.map((groupId) => byId(state.implementationGroups, groupId)?.name)),
      ];
      const themeNames = linked.flatMap((implementation) => implementation.themeIds.map((themeId) => byId(state.themes, themeId)?.name));
      const conflictText = state.conflicts.filter((conflict) => conflict.implementationIds.some((implementationId) => linkedIds.has(implementationId))).flatMap((conflict) => [conflict.name, detailsText(conflict)]);
      const requirementText = requirements().filter((requirement) => linkedIds.has(requirement.fromImplementationId) || linkedIds.has(requirement.toImplementationId)).flatMap((requirement) => [
        byId(state.implementations, requirement.fromImplementationId)?.title,
        byId(state.implementations, requirement.toImplementationId)?.title,
        detailsText(requirement),
      ]);
      return [
        idea.title,
        detailsText(idea),
        ...linked.flatMap((implementation) => [implementation.title, detailsText(implementation)]),
        ...groupNames,
        ...themeNames,
        ...conflictText,
        ...requirementText,
      ].filter(Boolean).join(' ').toLowerCase().includes(search);
    })
    .sort((left, right) => {
      if (v.ideaSort === 'manual') return numberSort(left, right);
      const metric = (idea) => {
        const linked = effective.filter((implementation) => implementation.ideaIds.includes(idea.id));
        if (v.ideaSort === 'implementations') return linked.length;
        if (v.ideaSort === 'locked') return linked.filter((implementation) => v.lockedImplementationIds.includes(implementation.id)).length;
        return allConflicts.filter((conflict) => conflict.implementationIds.some((implementationId) => linked.some((implementation) => implementation.id === implementationId))).length;
      };
      const result = metric(left) - metric(right);
      return (v.ideaSortDirection === 'desc' ? -result : result) || numberSort(left, right);
    });

  if (!ideas.length) {
    board.innerHTML = state.ideas.length
      ? '<div class="gate-card empty-workflow"><h2>No ideas match this view</h2><p class="muted">Clear search or filters to return to the board.</p><button class="button secondary" data-action="open-mobile-filters">Review filters</button></div>'
      : `<div class="gate-card empty-workflow"><p class="eyebrow">A simple path from thought to decision</p><h2>Start with one idea</h2><p class="muted">Capture what you are considering first. Implementations, constraints, and saved decisions can come later.</p><ol class="onboarding-steps"><li class="active"><strong>1. Add an idea</strong><span>Name the opportunity or question.</span></li><li><strong>2. Add implementations</strong><span>Describe possible ways to realize it.</span></li><li><strong>3. Test a decision</strong><span>Lock choices and explain any blockers.</span></li><li><strong>4. Save the view</strong><span>Keep a deliberate snapshot for comparison.</span></li></ol><button class="button primary" data-action="add-idea">+ Add first idea</button></div>`;
  } else {
    board.innerHTML = ideas.map((idea) => {
      const groups = idea.groupIds.map((groupId) => byId(state.ideaGroups, groupId)).filter(Boolean);
      const implementations = effective.filter((implementation) => implementation.ideaIds.includes(idea.id));
      const visibleImplementations = implementations.filter((implementation) => visible.has(implementation.id));
      const hiddenImplementations = implementations.filter((implementation) => !visible.has(implementation.id));
      const allHidden = implementations.length > 0 && visibleImplementations.length === 0;
      const sortedVisible = [...visibleImplementations].sort((a, b) => implementationOrderForIdea(a, idea.id) - implementationOrderForIdea(b, idea.id) || numberSort(a, b));
      const expanded = v.expandedIdeaIds.includes(idea.id);
      return `<section class="idea-card" data-idea-id="${idea.id}" style="${ideaCardStyle(idea)}">
        <header class="idea-header">
          <h2 class="idea-title"><button class="idea-title-button" data-action="open-idea-inspector" data-id="${idea.id}" title="Open idea details">${escapeHtml(idea.title)}</button></h2>
          <div class="idea-control-row">
            <div class="idea-group-dots" aria-label="Idea groups">${groups.map((group) => `<span class="color-dot" title="${escapeHtml(group.name || 'Untitled group')}" style="background:${group.color || '#d5dbe5'}"></span>`).join('')}</div>
            <div class="idea-actions">
              <button class="icon-button drag-handle" data-reorder-kind="idea" data-reorder-id="${idea.id}" aria-label="Reorder idea ${escapeHtml(idea.title)}. Use the arrow keys." title="Drag or use arrow keys to reorder">⠿</button>
              <button class="icon-button" data-action="toggle-idea-details" data-id="${idea.id}" title="Toggle details">${expanded ? '▴' : '▾'}</button>
              <button class="icon-button" data-action="edit-idea" data-id="${idea.id}" title="Edit idea">✎</button>
              <button class="icon-button" data-action="add-implementation" data-idea-id="${idea.id}" title="Add implementation">＋</button>
            </div>
          </div>
        </header>
        ${expanded && detailsText(idea) ? `<div class="idea-details">${markdownToSafeHtml(detailsText(idea))}</div>` : ''}
        ${allHidden ? `<div class="hidden-strip hidden-implementation-summary" aria-label="Hidden implementations">${hiddenImplementations.map((implementation) => `<span class="hidden-chip">${escapeHtml(implementation.title)} <button data-action="show-implementation" data-id="${implementation.id}">show</button></span>`).join('')}</div>` : `<div class="implementation-list">
          ${sortedVisible.length ? sortedVisible.map((implementation) => renderImplementationRow(implementation, allConflicts, v)).join('') : `<div class="empty-impl">${implementations.length ? 'All implementations are hidden.' : 'No implementation in this theme.'}</div>`}
          ${hiddenImplementations.length ? `<div class="hidden-strip">${hiddenImplementations.map((implementation) => `<span class="hidden-chip">${escapeHtml(implementation.title)} <button data-action="show-implementation" data-id="${implementation.id}">show</button></span>`).join('')}</div>` : ''}
        </div>`}
      </section>`;
    }).join('');
  }

  const focusBanner = $('#conflict-focus-banner');
  const focused = focusedConflictId ? byId(allConflicts, focusedConflictId) : null;
  if (focused) {
    focusBanner.hidden = false;
    focusBanner.innerHTML = `<strong>${escapeHtml(focused.name)}</strong>${detailsText(focused) ? ` — ${escapeHtml(detailsText(focused).slice(0, 180))}` : ''} <button class="link-button" data-action="clear-conflict-focus">Clear highlight</button>`;
  } else if (v.selectedImplementationIds.length) {
    const available = effective.map((item) => item.id);
    const required = new Set();
    const conflicts = new Set();
    for (const selectedId of v.selectedImplementationIds) {
      const proposal = lockWithRequirements(allConflicts, requirements(), v.lockedImplementationIds, selectedId, available);
      for (const requirementId of proposal.locked) if (!v.selectedImplementationIds.includes(requirementId) && !v.lockedImplementationIds.includes(requirementId)) required.add(requirementId);
      for (const conflict of proposal.completedConflicts) conflicts.add(conflict.name);
    }
    focusBanner.hidden = false;
    focusBanner.innerHTML = `<strong>Decision preview:</strong> ${v.selectedImplementationIds.length} selected${required.size ? ` · adds ${required.size} required choice${required.size === 1 ? '' : 's'}` : ''}${conflicts.size ? ` · blocked by ${[...conflicts].slice(0, 3).map(escapeHtml).join(', ')}` : ' · no completed conflicts'} <button class="link-button" data-action="lock-selected">${conflicts.size ? 'Try valid choices' : 'Lock selection'}</button> <button class="link-button" data-action="clear-selection">Clear</button>`;
  } else focusBanner.hidden = true;
}

function draggableBoardItem(target) {
  const handle = target.closest('.drag-handle');
  if (!handle) return null;
  const implementation = target.closest('.impl-row');
  if (implementation) return { kind: 'implementation', source: implementation, id: implementation.dataset.implementationId, ideaId: implementation.closest('.idea-card')?.dataset.ideaId };
  const idea = target.closest('.idea-card');
  if (idea) return { kind: 'idea', source: idea, id: idea.dataset.ideaId };
  return null;
}

function keyboardReorderBoardItem(target, delta) {
  const item = draggableBoardItem(target);
  if (!item?.id) return;
  if (item.kind === 'idea') {
    const orderedIds = [...state.ideas].sort(numberSort).map((idea) => idea.id);
    const from = orderedIds.indexOf(item.id);
    const to = Math.max(0, Math.min(orderedIds.length - 1, from + delta));
    if (from === to) return;
    [orderedIds[from], orderedIds[to]] = [orderedIds[to], orderedIds[from]];
    ideaOrder(state.ideas, orderedIds);
  } else {
    const orderedIds = implementationsForTheme()
      .filter((implementation) => implementation.ideaIds.includes(item.ideaId))
      .sort((a, b) => implementationOrderForIdea(a, item.ideaId) - implementationOrderForIdea(b, item.ideaId) || numberSort(a, b))
      .map((implementation) => implementation.id);
    const from = orderedIds.indexOf(item.id);
    const to = Math.max(0, Math.min(orderedIds.length - 1, from + delta));
    if (from === to) return;
    [orderedIds[from], orderedIds[to]] = [orderedIds[to], orderedIds[from]];
    implementationOrder(state.implementations, item.ideaId, orderedIds);
  }
  renderBoard();
  markDirty();
  $(`.drag-handle[data-reorder-id="${CSS.escape(item.id)}"]`, $('#board'))?.focus();
  showToast(`${item.kind === 'idea' ? 'Idea' : 'Implementation'} moved ${delta < 0 ? 'up' : 'down'}.`);
}

function beginBoardPointer(event) {
  if (activeDrag || (event.pointerType === 'mouse' && event.button !== 0)) return;
  const item = draggableBoardItem(event.target);
  if (!item?.id) return;
  activeDrag = { ...item, handle: Boolean(event.target.closest('.drag-handle')), pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, dragging: false, ghost: null };
  item.source.setPointerCapture?.(event.pointerId);
}

function moveDragGhost(drag, event) {
  if (!drag.ghost) return;
  drag.ghost.style.transform = `translate(${event.clientX + 12}px, ${event.clientY + 12}px)`;
}

function startBoardDrag(drag, event) {
  drag.dragging = true;
  drag.source.classList.add('drag-origin');
  const rect = drag.source.getBoundingClientRect();
  drag.ghost = drag.source.cloneNode(true);
  drag.ghost.classList.remove('drag-origin');
  drag.ghost.className = `${drag.ghost.className} drag-ghost`;
  drag.ghost.style.width = `${rect.width}px`;
  drag.ghost.style.transform = `translate(${event.clientX + 12}px, ${event.clientY + 12}px)`;
  document.body.append(drag.ghost);
  document.body.classList.add('is-dragging-board');
}

function reorderDragSlot(drag, event) {
  const target = document.elementFromPoint(event.clientX, event.clientY);
  if (!target) return;
  const candidate = drag.kind === 'idea' ? target.closest('.idea-card') : target.closest('.impl-row');
  if (!candidate || candidate === drag.source) return;
  if (drag.kind === 'implementation' && candidate.closest('.idea-card')?.dataset.ideaId !== drag.ideaId) return;
  const rect = candidate.getBoundingClientRect();
  const sameRow = drag.kind === 'idea' && Math.abs(event.clientY - (rect.top + rect.height / 2)) < rect.height / 3;
  const before = sameRow ? event.clientX < rect.left + rect.width / 2 : event.clientY < rect.top + rect.height / 2;
  candidate.parentElement.insertBefore(drag.source, before ? candidate : candidate.nextSibling);
}

function finishBoardDrag(event, cancelled = false) {
  const drag = activeDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  activeDrag = null;
  drag.source.releasePointerCapture?.(event.pointerId);
  if (drag.dragging) {
    drag.ghost?.remove();
    drag.source.classList.remove('drag-origin');
    document.body.classList.remove('is-dragging-board');
    if (!cancelled) {
      if (drag.kind === 'idea') ideaOrder(state.ideas, $$('#board > .idea-card').map((item) => item.dataset.ideaId));
      else {
        const list = drag.source.closest('.implementation-list');
        implementationOrder(state.implementations, drag.ideaId, $$('.impl-row', list).map((item) => item.dataset.implementationId));
      }
      renderBoard();
      markDirty();
    } else renderBoard();
    event.preventDefault();
    return;
  }
  if (drag.handle) return;
  if (drag.kind === 'idea') {
    const v = view();
    v.expandedIdeaIds = v.expandedIdeaIds.includes(drag.id) ? v.expandedIdeaIds.filter((id) => id !== drag.id) : [...v.expandedIdeaIds, drag.id];
    renderBoard();
    markDirty();
  } else {
    currentInspectorId = drag.id;
    renderInspector(true);
  }
}

function moveBoardDrag(event) {
  const drag = activeDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (!drag.dragging && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 7) return;
  if (!drag.dragging) startBoardDrag(drag, event);
  moveDragGhost(drag, event);
  reorderDragSlot(drag, event);
  event.preventDefault();
}

function stripHtml(value = '') {
  const doc = new DOMParser().parseFromString(value, 'text/html');
  return doc.body.textContent || '';
}

function renderInspector(resetScroll = false) {
  const workspace = $('.workspace');
  const inspector = $('#inspector');
  const idea = currentInspectorIdeaId ? byId(state.ideas, currentInspectorIdeaId) : null;
  if (idea) {
    workspace.classList.add('has-inspector');
    inspector.hidden = false;
    const groups = idea.groupIds.map((groupId) => byId(state.ideaGroups, groupId)).filter(Boolean);
    const implementationCount = state.implementations.filter((implementation) => implementation.ideaIds.includes(idea.id)).length;
    inspector.innerHTML = `<form id="idea-inspector-form">
      <div class="inspector-heading"><h2>Idea details</h2><button type="button" class="icon-button" data-action="close-inspector" aria-label="Close idea details">×</button></div>
      <label class="field"><span>Title</span><input name="title" value="${escapeHtml(idea.title)}" required /></label>
      <label class="field"><span>Details / notes</span>${richEditor(detailsText(idea), 'Describe this idea…')}</label>
      <div class="inspector-actions"><button type="submit" class="button primary">Save details</button><button type="button" class="button ghost" data-action="edit-idea" data-id="${idea.id}">Edit groups</button><button type="button" class="button danger" data-action="delete-idea" data-id="${idea.id}">Delete</button></div>
    </form>
    <section class="inspector-section"><h3>At a glance</h3><div class="inspector-list"><div class="inspector-item"><span>Implementations</span><span>${implementationCount}</span></div><div class="inspector-item"><span>Idea groups</span><span>${escapeHtml(groups.map((group) => group.name || 'Untitled group').join(', ') || 'None')}</span></div></div></section>`;
    if (resetScroll) inspector.scrollTop = 0;
    return;
  }
  const effective = implementationsForTheme();
  const implementation = currentInspectorId ? byId(state.implementations, currentInspectorId) : null;
  if (!implementation || !effective.some((item) => item.id === implementation.id)) {
    currentInspectorId = null;
    currentInspectorIdeaId = null;
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
    <div class="inspector-heading"><h2>Implementation details</h2><button type="button" class="icon-button" data-action="close-inspector" aria-label="Close implementation details">Ã—</button></div>
    <p class="tiny muted">One underlying implementation, repeated beneath every linked idea.</p>
    <label class="field"><span>Title</span><input name="title" value="${escapeHtml(implementation.title)}" required /></label>
    <label class="field"><span>Details / notes</span>${richEditor(detailsText(implementation), 'Markdown notes…')}</label>
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
  if (resetScroll) inspector.scrollTop = 0;
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
  state = validateProjectDocument(status.state);
  for (const item of [...state.ideas, ...state.implementations, ...state.conflicts, ...requirements()]) {
    if (!item.detailsMarkdown && item.detailsHtml) item.detailsMarkdown = htmlToMarkdown(item.detailsHtml);
    delete item.detailsHtml;
  }
  projectPath = status.path;
  currentProjectId = status.projectId || state.meta.id || 'guest';
  currentRevision = Number(status.revision || 0);
  lastSavedSnapshot = projectContentFingerprint(state);
  undoStack = [];
  redoStack = [];
  historyBaseline = JSON.stringify(state);
  gate.hidden = true;
  app.hidden = false;
  configureSaveCoordinator();
  render();
  if (storageMode === 'guest') hydrateGuestAttachments(state).then(() => render()).catch(() => {});
  renderStorageNotice();
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
  storageMode = 'guest'; currentProjectId = 'guest'; currentRevision = 0; guestState = readGuestState(); await loadStatus();
}

async function connectSignedInUser() {
  const browserProject = structuredClone(state || readGuestState());
  storageMode = 'cloud';
  const status = await api('/api/status');
  if (!status.open) {
    storageMode = 'guest';
    guestState = browserProject;
    cloudWorkspaceReady = false;
    renderStorageNotice();
    showToast('Your account is not provisioned for cloud storage yet. This browser project is unchanged.');
    return;
  }
  cloudWorkspaceReady = true;
  currentProjectId = status.projectId || currentProjectId;
  currentRevision = Number(status.revision || 0);
  const browserHasWork = guestHasWork(browserProject);
  const cloudHasWork = guestHasWork(status.state);
  if (browserHasWork && !cloudHasWork) {
    await uploadBrowserProjectToCloud(browserProject, 'This browser project is now saved to your private account.');
    return;
  }
  if (browserHasWork && cloudHasWork) {
    storageMode = 'guest';
    guestState = browserProject;
    saveGuestState(browserProject);
    pendingCloudConflict = status;
    openWorkbench({ state: browserProject, path: 'This browser (not uploaded)' });
    openCloudConflictModal();
    return;
  }
  openWorkbench(status);
}

async function retryCloudConnection() {
  if (!clerk?.user) return;
  try { await connectSignedInUser(); }
  catch (error) { renderStorageNotice(); showToast(`Could not connect cloud storage: ${error.message}`); }
}

async function uploadBrowserProjectToCloud(browserProject, successMessage) {
  try {
    storageMode = 'cloud';
    const saved = await api('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: browserProject, baseRevision: currentRevision }) });
    localStorage.setItem(GUEST_BACKUP_KEY, JSON.stringify(browserProject));
    localStorage.removeItem(GUEST_STORAGE_KEY);
    guestState = null;
    pendingCloudConflict = null;
    openWorkbench({ state: saved.state, path: 'Private cloud workspace', projectId: saved.projectId || currentProjectId, revision: saved.revision });
    showToast(successMessage);
  } catch (error) {
    storageMode = 'guest';
    guestState = browserProject;
    saveGuestState(browserProject);
    renderStorageNotice();
    showToast(`Your browser project was not moved: ${error.message}`);
  }
}

async function moveGuestProjectToCloud() {
  if (!clerk?.user || !cloudWorkspaceReady || storageMode !== 'guest' || !state) return;
  await uploadBrowserProjectToCloud(structuredClone(state), 'This browser project is now saved to your private account.');
}

function openCloudConflictModal() {
  if (!pendingCloudConflict) return;
  modalManager('Choose project to keep', `<p>Your account already has a cloud project, and this browser also has unsynced work.</p><p class="muted">Nothing will be overwritten until you choose.</p><div class="manager-list"><button class="button primary" data-action="use-cloud-project">Use the existing cloud project</button><button class="button secondary" data-action="replace-cloud-project">Replace cloud with this browser project</button><button class="button ghost" data-action="close-modal">Decide later</button></div>`);
}

function openProjectMenu() {
  const accountAction = clerk?.user ? '<button class="button secondary" data-action="open-sign-out-menu">Sign out</button>' : '';
  const addLibraryButton = storageMode === 'cloud';
  modalManager('Project', `<p><strong>${escapeHtml(state.meta.name)}</strong></p><p class="muted">${escapeHtml(projectPath)}</p><div class="manager-list"><button class="button secondary" data-action="open-share-menu">Share project</button>${addLibraryButton ? '<button class="button secondary" data-action="open-project-history">History and checkpoints</button>' : ''}<button class="button secondary" data-action="open-export-menu">Export…</button><button class="button secondary" data-action="open-import-menu">Import…</button>${accountAction}<button class="button danger" data-action="close-project">Close project</button></div>`);
  if (addLibraryButton) {
    const button = document.createElement('button');
    button.className = 'button primary';
    button.dataset.action = 'open-project-library';
    button.textContent = 'All projects';
    $('.manager-list', modalBody)?.prepend(button);
  }
}

async function openProjectHistory() {
  try {
    const payload = await api(`/api/projects/${encodeURIComponent(currentProjectId)}/revisions`);
    const rows = (payload.revisions || []).map((revision) => `<div class="manager-row"><div><strong>${escapeHtml(revision.label || `Revision ${revision.revision}`)}</strong><div class="tiny muted">Revision ${revision.revision} · ${new Date(revision.createdAt || revision.created_at).toLocaleString()}</div></div><button class="button secondary compact" data-action="restore-project-revision" data-id="${revision.id}">Restore</button></div>`).join('');
    modalManager('History and checkpoints', `<div class="manager-heading"><p class="muted">Up to 100 revisions from the last 30 days are retained.</p><button class="button primary compact" data-action="create-project-checkpoint">Name current version</button></div><div class="manager-list">${rows || '<p class="muted">No earlier revisions yet.</p>'}<button class="button ghost" data-action="project-menu">Back</button></div>`);
  } catch (error) { showToast(`Could not load history: ${error.message}`); }
}

async function checkpointBeforeImport(label = 'Before import') {
  if (storageMode !== 'cloud') return;
  await saveState();
  await saveCoordinator?.flush();
  await api(`/api/projects/${encodeURIComponent(currentProjectId)}/revisions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }) });
}

async function openProjectLibrary() {
  if (storageMode !== 'cloud') return;
  try {
    const [active, all] = await Promise.all([api('/api/projects'), api('/api/projects?archived=true')]);
    const archived = (all.projects || []).filter((project) => project.archivedAt);
    const row = (project, archivedProject = false) => `<div class="manager-row"><div><strong>${escapeHtml(project.name)}</strong><div class="tiny muted">${project.counts.ideas} ideas · ${project.counts.implementations} implementations · updated ${new Date(project.updatedAt).toLocaleDateString()}</div></div><div class="manager-row-actions">${archivedProject ? `<button class="button secondary compact" data-action="restore-project" data-id="${project.id}">Restore</button>` : `<button class="button secondary compact" data-action="switch-project" data-id="${project.id}" ${project.id === currentProjectId ? 'disabled' : ''}>Open</button><button class="button ghost compact" data-action="duplicate-project" data-id="${project.id}">Duplicate</button><button class="button danger compact" data-action="archive-project" data-id="${project.id}">Archive</button>`}</div></div>`;
    modalManager('Projects', `<div class="form-actions"><button class="button ghost" data-action="project-menu">Back</button><button class="button primary" data-action="new-project">New project</button></div><div class="manager-list">${(active.projects || []).map((project) => row(project)).join('') || '<p class="muted">No active projects.</p>'}</div>${archived.length ? `<h3>Archived</h3><div class="manager-list">${archived.map((project) => row(project, true)).join('')}</div>` : ''}`);
  } catch (error) {
    showToast(`Could not load projects: ${error.message}`);
  }
}

function openNewProjectForm() {
  modalForm('New project', '<label class="field"><span>Project name</span><input name="name" value="My Ideation Project" required autofocus /></label>', async (form) => {
    const name = String(new FormData(form).get('name') || '').trim();
    if (!name) throw new Error('Project name is required.');
    const result = await api('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    void captureEvent('project_created', { storage_mode: 'cloud' });
    closeModal();
    openWorkbench({ state: result.state, path: 'Private cloud workspace', projectId: result.project.id, revision: result.project.revision });
    showToast('Project created.');
  }, 'Create');
}

async function switchProject(projectId) {
  const result = await api(`/api/projects/${encodeURIComponent(projectId)}`);
  closeModal();
  openWorkbench({ state: result.state, path: 'Private cloud workspace', projectId: result.project.id, revision: result.project.revision });
}

async function openShareMenu() {
  if (storageMode !== 'cloud' && clerk?.user) {
    await retryCloudConnection();
    if (pendingCloudConflict) return;
  }
  if (storageMode !== 'cloud') {
    modalManager('Share project', `<p>Public links are available after this project has been saved to your private cloud workspace.</p><p class="muted">Sign in and save this browser project first, then return here to create a permanent read-only link.</p><div class="manager-list"><button class="button ghost" data-action="project-menu">Back</button></div>`);
    return;
  }
  try {
    const payload = await api(`/api/projects/${encodeURIComponent(currentProjectId)}/shares`);
    const shares = payload.shares || [];
    const rows = shares.length ? shares.map((share) => `<div class="manager-row"><div><strong>${share.mode === 'live' ? 'Live link' : 'Snapshot'}</strong><div class="tiny muted">${share.revokedAt ? 'Revoked' : share.expiresAt ? `Expires ${new Date(share.expiresAt).toLocaleDateString()}` : 'No expiry'} · ${new Date(share.createdAt).toLocaleDateString()}</div>${share.revokedAt ? '' : `<a href="${escapeHtml(share.url)}" target="_blank" rel="noopener">${escapeHtml(share.url)}</a>`}</div>${share.revokedAt ? '' : `<button class="button danger compact" data-action="revoke-project-share" data-id="${share.id}">Revoke</button>`}</div>`).join('') : '<p class="muted">No share links yet.</p>';
    modalManager('Share project', `<p>Create a read-only link. Public pages are marked not to be indexed.</p><div class="manager-list"><button class="button primary" data-action="create-project-share" data-share-mode="live">Create live link</button><button class="button secondary compact" data-action="create-project-share" data-share-mode="live" data-expiry-days="7">Create live link · expires in 7 days</button><p class="tiny muted">Readers see future changes as you save them.</p><button class="button secondary" data-action="create-project-share" data-share-mode="snapshot">Create snapshot link</button><button class="button secondary compact" data-action="create-project-share" data-share-mode="snapshot" data-expiry-days="30">Create snapshot · expires in 30 days</button><p class="tiny muted">Readers see exactly the project as it is now.</p><h3>Existing links</h3>${rows}<button class="button ghost" data-action="project-menu">Back</button></div>`);
  } catch (error) {
    showToast(`Could not load share links: ${error.message}`);
  }
}

function openExportMenu() {
  modalManager('Export project', `<p class="muted">Choose a format for a copy of this project.</p><div class="manager-list"><button class="button primary" data-action="export-project-zip">Portable ZIP</button><button class="button secondary" data-action="export-project-directory">Project directory</button><button class="button secondary" data-action="export-project">Markdown summary</button><button class="button ghost" data-action="project-menu">Back</button></div>`);
}

function openImportMenu() {
  modalManager('Import project', `<p class="muted">Import replaces the project currently open in this browser. Your private cloud project is not changed until the next save.</p><div class="manager-list"><button class="button primary" data-action="import-project-portable">Portable ZIP or project file</button><button class="button secondary" data-action="import-project-directory">Project directory</button><button class="button secondary" data-action="import-project">Markdown</button><button class="button ghost" data-action="project-menu">Back</button></div>`);
}

function openSignOutMenu(removeBrowserCopy) {
  if (typeof removeBrowserCopy !== 'boolean') {
    modalManager('Sign out', `<p>What should happen to this browser’s copy of the project?</p><div class="manager-list"><button class="button secondary" data-action="choose-sign-out-copy" data-remove-browser-copy="false">Keep a browser copy</button><button class="button danger" data-action="choose-sign-out-copy" data-remove-browser-copy="true">Remove the browser copy</button><button class="button ghost" data-action="project-menu">Back</button></div>`);
    return;
  }
  const detail = removeBrowserCopy ? 'The browser copy will be removed. Your private cloud project remains safe.' : 'A browser copy will be kept so you can continue locally after signing out.';
  modalManager('Confirm sign out', `<p>${detail}</p><div class="form-actions"><button class="button ghost" data-action="open-sign-out-menu">Back</button><button class="button danger" data-action="confirm-sign-out" data-remove-browser-copy="${removeBrowserCopy}">Sign out</button></div>`);
}

async function createProjectShare(mode, expiryDays = 0) {
  try {
    await saveState();
    const expiresAt = expiryDays ? new Date(Date.now() + Number(expiryDays) * 86400000).toISOString() : null;
    const share = await api(`/api/projects/${encodeURIComponent(currentProjectId)}/shares`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, expiresAt, view: { ...captureRichView(), themeId: state.activeThemeId } }) });
    void captureEvent('project_shared', { share_mode: mode, has_expiry: Boolean(expiresAt) });
    modalManager('Share link created', `<p>This ${share.expiresAt ? `expiring (${new Date(share.expiresAt).toLocaleDateString()})` : 'non-expiring'} ${share.mode === 'live' ? 'live' : 'snapshot'} link is read-only and marked not to be indexed.</p><label class="field"><span>Share link</span><input id="share-link" value="${escapeHtml(share.url)}" readonly /></label><div class="form-actions"><button class="button ghost" data-action="project-menu">Done</button><button class="button primary" data-action="copy-share-link">Copy link</button></div>`);
  } catch (error) { showToast(`Could not create the share link: ${error.message}`); }
}

async function copyShareLink() {
  const input = $('#share-link');
  if (!input) return;
  input.select();
  try { await navigator.clipboard.writeText(input.value); showToast('Share link copied.'); }
  catch { input.focus(); showToast('Share link selected—copy it from the field.'); }
}

async function signOutAndReturnToBrowser({ removeBrowserCopy = false } = {}) {
  if (!clerk) return;
  if (state && !removeBrowserCopy) saveGuestState(state);
  if (removeBrowserCopy) localStorage.removeItem(GUEST_STORAGE_KEY);
  try {
    const posthog = await posthogReady;
    posthog?.reset();
  } catch (error) {
    console.error(error);
  }
  clerk.signOut(() => location.reload());
}

async function identifySignedInUser() {
  const userId = clerk?.user?.id;
  if (!userId) return;
  try {
    const posthog = await posthogReady;
    const email = clerk.user.primaryEmailAddress?.emailAddress;
    posthog?.identify(userId, email ? { email } : undefined);
  } catch (error) {
    console.error(error);
  }
}

function startProjectRename() {
  const title = $('#project-title');
  if (!title || !state || title.querySelector('input')) return;
  const original = state.meta.name;
  title.innerHTML = `<input id="project-title-input" value="${escapeHtml(original)}" aria-label="Project name" />`;
  const input = $('#project-title-input');
  const commit = () => {
    const next = input.value.trim();
    if (next && next !== original) { state.meta.name = next; markDirty(); }
    renderStats();
  };
  input.addEventListener('blur', commit, { once: true });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
    if (event.key === 'Escape') { input.value = original; input.blur(); }
  });
  input.focus();
  input.select();
}

async function initializeClerk() {
  if (clerkInitialization) return clerkInitialization;
  clerkStatus = 'loading';
  renderAccountControl();
  clerkInitialization = (async () => {
  const response = await fetch('/api/config');
  if (!response.ok) throw new Error('Authentication settings could not be loaded.');
  const config = await response.json();
  if (config.selfHosted) {
    selfHosted = true;
    clerkStatus = 'ready';
    return;
  }
  if (!config.clerkPublishableKey) throw new Error('Authentication is not configured yet.');
  clerk = await loadClerkBrowserSdk(config.clerkPublishableKey);
  await Promise.race([
    clerk.load({ afterSignInUrl: window.location.href, afterSignUpUrl: window.location.href }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Clerk took too long to initialize. Please try again.')), 15000)),
  ]);
  await identifySignedInUser();
  clerkStatus = 'ready';
  renderAccountControl();
  })();
  try { return await clerkInitialization; }
  catch (error) { clerkStatus = 'error'; throw error; }
  finally { clerkInitialization = null; }
}

function renderAccountControl() {
  const button = $('#account-button');
  if (!button) return;
  if (selfHosted) {
    button.hidden = true;
    return;
  }
  if (clerkStatus === 'loading') {
    button.disabled = true;
    button.innerHTML = '<span class="loading-spinner" aria-hidden="true"></span> Loading sign-in…';
    button.setAttribute('aria-busy', 'true');
    return;
  }
  button.disabled = false;
  button.removeAttribute('aria-busy');
  const signedIn = Boolean(clerk?.user);
  button.dataset.action = signedIn ? 'open-sign-out-menu' : 'sign-in';
  button.textContent = signedIn ? 'Sign out' : 'Sign in';
}

function loadClerkBrowserSdk(publishableKey) {
  if (window.Clerk) return Promise.resolve(window.Clerk);
  return new Promise((resolve, reject) => {
    const selector = 'script[data-ideation-clerk-sdk]';
    const existing = document.querySelector(selector);
    const script = existing || document.createElement('script');
    const finish = () => window.Clerk ? resolve(window.Clerk) : reject(new Error('Clerk UI components did not load.'));
    script.addEventListener('load', finish, { once: true });
    script.addEventListener('error', () => reject(new Error('Clerk UI components could not be loaded.')), { once: true });
    if (!existing) {
      script.dataset.ideationClerkSdk = '';
      script.dataset.clerkPublishableKey = publishableKey;
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.src = 'https://clerk.teleoflexuous.com/npm/@clerk/clerk-js@6.25.8/dist/clerk.browser.js';
      document.head.append(script);
    }
  });
}

async function boot() {
  $('#project-path')?.closest('.field')?.setAttribute('hidden', '');
  $('#project-name')?.closest('.field')?.setAttribute('hidden', '');
  $('[data-action="open-project"]')?.setAttribute('hidden', '');
  $('#included-projects')?.setAttribute('hidden', '');
  try {
    await continueAsGuest();
    await initializeClerk();
    if (selfHosted) {
      storageMode = 'cloud';
      const status = await api('/api/status');
      if (status.open) openWorkbench(status);
      renderAccountControl();
      return;
    }
    if (clerk.user) await connectSignedInUser();
    else renderStorageNotice();
    renderAccountControl();
  } catch (error) {
    authenticationError = error.message || 'Authentication could not be initialized.';
    clerkStatus = 'error';
    clerk = null;
    renderStorageNotice();
    renderAccountControl();
    console.warn('Cloud account features are unavailable:', error);
  }
}

function openIdeaForm(ideaId = null) {
  const idea = ideaId ? byId(state.ideas, ideaId) : null;
  modalForm(idea ? 'Edit idea' : 'Add idea', `
    <div class="form-grid">
      <label class="field full"><span>Succinct title</span><input name="title" value="${escapeHtml(idea?.title || '')}" required autofocus /></label>
      <label class="field full"><span>Idea groups</span>${checkboxGrid('groupIds', state.ideaGroups, idea?.groupIds || [])}</label>
      <label class="field full"><span>Details</span>${richEditor(detailsText(idea), 'Details for this idea…')}</label>
    </div>
    ${idea ? `<button type="button" class="button danger" data-action="delete-idea" data-id="${idea.id}">Delete idea</button>` : ''}
  `, async (form) => {
    const formData = new FormData(form);
    const title = String(formData.get('title') || '').trim();
    if (!title) throw new Error('A title is required.');
    const payload = {
      id: idea?.id || id(), title, detailsMarkdown: getRichValue(), groupIds: formData.getAll('groupIds').map(String), sortOrder: idea?.sortOrder ?? state.ideas.length,
    };
    if (idea) Object.assign(idea, payload);
    else {
      state.ideas.push(payload);
      void captureEvent('idea_created', { group_count: payload.groupIds.length });
    }
    closeModal(); render(); markDirty();
  });
}

function openImplementationForm(implementationId = null, preselectedIdeaId = null) {
  const implementation = implementationId ? byId(state.implementations, implementationId) : null;
  modalForm(implementation ? 'Edit implementation' : 'Add implementation', `
    <div class="form-grid">
      <label class="field full"><span>Succinct title</span><input name="title" value="${escapeHtml(implementation?.title || '')}" required autofocus /></label>
      <label class="field full"><span>Details / notes</span>${richEditor(detailsText(implementation), 'Describe this implementation…')}</label>
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
      id: implementation?.id || id(), title, detailsMarkdown: getRichValue(), ideaIds, themeIds,
      groupIds: formData.getAll('groupIds').map(String), sortOrder: implementation?.sortOrder ?? state.implementations.length,
      attachments: implementation?.attachments || [],
    };
    if (implementation) Object.assign(implementation, payload);
    else {
      state.implementations.push(payload);
      void captureEvent('implementation_created', { idea_count: ideaIds.length, theme_count: themeIds.length, group_count: payload.groupIds.length });
    }
    currentInspectorId = payload.id;
    closeModal(); render(); markDirty();
  });
}

function openConflictForm(conflictId = null, overridesConflictId = null, preselectedImplementationId = null, returnToRelationshipsId = null) {
  const conflict = conflictId ? byId(state.conflicts, conflictId) : null;
  const base = overridesConflictId ? byId(state.conflicts, overridesConflictId) : null;
  const selectedIds = conflict?.implementationIds || base?.implementationIds || (preselectedImplementationId ? [preselectedImplementationId] : []);
  const selectedScope = conflict ? (conflict.themeId ?? 'global') : state.activeThemeId;
  modalForm(conflict ? 'Edit conflict' : overridesConflictId ? 'Override inherited conflict' : 'Add conflict', `
    <div class="form-grid">
      <label class="field full"><span>Name</span><input name="name" value="${escapeHtml(conflict?.name || base?.name || '')}" required autofocus /></label>
      <label class="field"><span>Scope</span><select name="themeId"><option value="global" ${selectedScope === 'global' ? 'selected' : ''}>Global</option>${state.themes.map((theme) => `<option value="${theme.id}" ${selectedScope === theme.id ? 'selected' : ''}>${escapeHtml(theme.name)}</option>`).join('')}</select></label>
      <div></div>
      <label class="field full"><span>Members — the conflict activates only when every selected member is locked</span>${checkboxGrid('implementationIds', state.implementations, selectedIds, (item) => item.title)}</label>
      <label class="field full"><span>Explanation</span>${richEditor(detailsText(conflict) || detailsText(base), 'Why is the complete combination invalid?')}</label>
    </div>
  `, async (form) => {
    const formData = new FormData(form);
    const name = String(formData.get('name') || '').trim();
    const implementationIds = formData.getAll('implementationIds').map(String);
    if (!name) throw new Error('A conflict name is required.');
    if (implementationIds.length < 2) throw new Error('A conflict needs at least two implementations.');
    const rawThemeId = String(formData.get('themeId'));
    const payload = {
      id: conflict?.id || id(), name, detailsMarkdown: getRichValue(), themeId: rawThemeId === 'global' ? null : rawThemeId,
      implementationIds, overridesConflictId: conflict?.overridesConflictId || overridesConflictId || null,
    };
    if (conflict) Object.assign(conflict, payload);
    else {
      state.conflicts.push(payload);
      void captureEvent('conflict_created', { member_count: implementationIds.length, scope: payload.themeId ? 'theme' : 'global', is_override: Boolean(payload.overridesConflictId) });
    }
    closeModal(); render(); markDirty();
    if (returnToRelationshipsId) openImplementationRelationships(returnToRelationshipsId);
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
    return `<div class="manager-row"><div><strong>${escapeHtml(conflict.name)}</strong><div class="tiny muted">${conflict.implementationIds.length} members · ${conflict.themeId === null ? 'Global' : escapeHtml(themeName(conflict.themeId))}${conflict.overridesConflictId ? ' · Override' : ''}</div>${detailsText(conflict) ? `<div class="tiny">${escapeHtml(detailsText(conflict).slice(0, 150))}</div>` : ''}</div>
      <div class="manager-row-actions">${local ? `<button class="button ghost" data-action="edit-conflict" data-id="${conflict.id}">Edit</button><button class="button danger" data-action="delete-conflict" data-id="${conflict.id}">Delete</button>` : `<button class="button ghost" data-action="override-conflict" data-id="${conflict.id}">Override</button><button class="button ghost" data-action="hide-conflict" data-id="${conflict.id}">Hide here</button>`}</div></div>`;
  }).join('');
  const chain = themeChain(state.themes, state.activeThemeId);
  const hiddenRows = (activeTheme().hiddenInheritedConflictIds || [])
    .map((conflictId) => byId(state.conflicts, conflictId))
    .filter((conflict) => conflict && (conflict.themeId === null || chain.includes(conflict.themeId)))
    .map((conflict) => `<div class="manager-row"><div><strong>${escapeHtml(conflict.name)}</strong><div class="tiny muted">Hidden inherited conflict</div></div><div class="manager-row-actions"><button class="button secondary" data-action="unhide-conflict" data-id="${conflict.id}">Restore</button></div></div>`).join('');
  modalManager(`Conflicts in ${activeTheme().name}`, `<div class="manager-heading"><p class="callout">A conflict set becomes invalid only when every member is locked. Subsets remain valid.</p><button class="button primary" data-action="add-conflict">+ Conflict</button></div><div class="manager-list">${rows || '<p class="muted">No conflicts apply to this theme.</p>'}</div>${hiddenRows ? `<section class="manager-section"><h3>Hidden inherited conflicts</h3><div class="manager-list">${hiddenRows}</div></section>` : ''}`);
}

function openRequirementForm(requirementId = null, preselectedFromImplementationId = null, returnToRelationshipsId = null) {
  const requirement = requirementId ? byId(requirements(), requirementId) : null;
  if (state.implementations.length < 2) { showToast('Create at least two implementations first.'); return; }
  modalForm(requirement ? 'Edit requirement' : 'Add requirement', `
    <div class="form-grid"><label class="field full"><span>When this implementation is locked…</span><select name="fromImplementationId">${state.implementations.map((implementation) => `<option value="${implementation.id}" ${requirement?.fromImplementationId === implementation.id ? 'selected' : ''}>${escapeHtml(implementation.title)}</option>`).join('')}</select></label>
    <label class="field full"><span>…this implementation must also be locked</span><select name="toImplementationId">${state.implementations.map((implementation) => `<option value="${implementation.id}" ${requirement?.toImplementationId === implementation.id ? 'selected' : ''}>${escapeHtml(implementation.title)}</option>`).join('')}</select></label>
    <p class="callout full">Requirements are directional. Add both directions for a bidirectional requirement; cycles and multistep chains are supported.</p></div>
  `, async (form) => {
    const data = new FormData(form);
    const fromImplementationId = String(data.get('fromImplementationId'));
    const toImplementationId = String(data.get('toImplementationId'));
    if (fromImplementationId === toImplementationId) throw new Error('Choose two different implementations.');
    if (requirements().some((item) => item.id !== requirement?.id && item.fromImplementationId === fromImplementationId && item.toImplementationId === toImplementationId)) throw new Error('That directional requirement already exists.');
    const payload = { id: requirement?.id || id(), fromImplementationId, toImplementationId };
    if (requirement) Object.assign(requirement, payload);
    else {
      requirements().push(payload);
      void captureEvent('requirements_created', { requirement_count: 1, source: 'form' });
    }
    closeModal(); render(); markDirty();
    if (returnToRelationshipsId) openImplementationRelationships(returnToRelationshipsId); else openRequirementsManager();
  });
  if (!requirement && preselectedFromImplementationId) modalBody.querySelector('[name="fromImplementationId"]').value = preselectedFromImplementationId;
}

function openRequirementsManager() {
  const rows = requirements().map((requirement) => {
    const from = byId(state.implementations, requirement.fromImplementationId);
    const to = byId(state.implementations, requirement.toImplementationId);
    return `<div class="manager-row"><div><strong>${escapeHtml(from?.title || 'Missing implementation')} → ${escapeHtml(to?.title || 'Missing implementation')}</strong><div class="tiny muted">Locking the first automatically locks the second.</div></div><div class="manager-row-actions"><button class="button ghost" data-action="edit-requirement" data-id="${requirement.id}">Edit</button><button class="button danger" data-action="delete-requirement" data-id="${requirement.id}">Delete</button></div></div>`;
  }).join('');
  modalManager('Requirements', `<div class="manager-heading"><p class="callout">A → B means choosing A also chooses B. Add reverse edges for bidirectional requirements; cycles and chains are valid.</p><button class="button primary" data-action="add-requirement">+ Requirement</button></div><div class="manager-list">${rows || '<p class="muted">No requirements yet.</p>'}</div>`);
}

function openImplementationRelationships(implementationId) {
  const implementation = byId(state.implementations, implementationId);
  if (!implementation) return;
  const effectiveItem = implementationsForTheme().find((item) => item.id === implementationId);
  const conflicts = state.conflicts.filter((item) => item.implementationIds.includes(implementationId));
  const outgoing = requirements().filter((item) => item.fromImplementationId === implementationId);
  const incoming = requirements().filter((item) => item.toImplementationId === implementationId);
  const themeOrigins = (effectiveItem?.originThemeIds || implementation.themeIds).map((themeId) => `${escapeHtml(themeName(themeId))}${themeId === state.activeThemeId ? ' (direct)' : ' (inherited)'}`).join(', ');
  const ideaNames = implementation.ideaIds.map((ideaId) => byId(state.ideas, ideaId)?.title).filter(Boolean);
  const groupNames = implementation.groupIds.map((groupId) => byId(state.implementationGroups, groupId)?.name || 'Untitled group');
  const requirementRow = (item, direction) => `<div class="manager-row"><div><strong>${escapeHtml(direction === 'out' ? 'Requires' : 'Required by')} ${escapeHtml(byId(state.implementations, direction === 'out' ? item.toImplementationId : item.fromImplementationId)?.title || 'Missing implementation')}</strong></div><button class="button ghost" data-action="edit-relationship-requirement" data-id="${item.id}" data-return-id="${implementationId}">Edit</button></div>`;
  modalManager(`Relationships: ${implementation.title}`, `<section class="manager-section"><div class="manager-heading"><h3>Implementation</h3><button class="button ghost compact" data-action="open-implementation-form" data-id="${implementationId}">Edit details</button></div><div class="inspector-list"><div class="inspector-item"><span>Ideas</span><span>${escapeHtml(ideaNames.join(', ') || 'None')}</span></div><div class="inspector-item"><span>Theme origin</span><span>${themeOrigins || 'None'}</span></div><div class="inspector-item"><span>Groups</span><span>${escapeHtml(groupNames.join(', ') || 'None')}</span></div></div>${detailsText(implementation) ? `<div class="impl-details">${markdownToSafeHtml(detailsText(implementation))}</div>` : ''}</section><section class="manager-section"><div class="manager-heading"><h3>Conflicts</h3><button class="button secondary compact" data-action="add-conflict-for-implementation" data-id="${implementationId}">+ Conflict</button></div><div class="manager-list">${conflicts.map((item) => `<div class="manager-row"><div><strong>${escapeHtml(item.name)}</strong><div class="tiny muted">${item.implementationIds.length} members</div></div><button class="button ghost" data-action="edit-relationship-conflict" data-id="${item.id}" data-return-id="${implementationId}">Edit</button></div>`).join('') || '<p class="muted">No conflicts.</p>'}</div></section><section class="manager-section"><div class="manager-heading"><h3>Requirements</h3><button class="button secondary compact" data-action="add-requirement-for-implementation" data-id="${implementationId}">+ Requirement</button></div><div class="manager-list">${outgoing.map((item) => requirementRow(item, 'out')).join('') || ''}${incoming.map((item) => requirementRow(item, 'in')).join('') || ''}${!outgoing.length && !incoming.length ? '<p class="muted">No requirements.</p>' : ''}</div></section><div class="form-actions"><button class="button ghost" data-action="close-modal">Close</button></div>`);
}

function relationshipPicker(preselectedIds, pickedIds, showAll, query, actionPrefix) {
  const preselected = new Set(preselectedIds); const picked = new Set(pickedIds);
  const top = state.implementations.filter((item) => preselected.has(item.id));
  const additional = state.implementations.filter((item) => !preselected.has(item.id) && fuzzyMatches(item.title, query));
  const option = (item) => `<button class="relationship-option ${picked.has(item.id) ? 'selected' : ''}" data-action="${actionPrefix}-toggle" data-id="${item.id}">${escapeHtml(item.title)}</button>`;
  if (!top.length) return `<div class="relationship-picker"><input class="relationship-search" data-relationship-search="${actionPrefix}" placeholder="Search implementations" value="${escapeHtml(query)}" autofocus /><div class="relationship-options">${additional.map(option).join('') || '<span class="muted tiny">No matching implementations.</span>'}</div></div>`;
  return `<div class="relationship-picker"><div class="relationship-selected">${top.map(option).join('') || '<span class="muted tiny">No preselected implementations.</span>'}</div><button class="relationship-more" data-action="${actionPrefix}-more">Show other implementations <span>▾</span></button>${showAll ? `<input class="relationship-search" data-relationship-search="${actionPrefix}" placeholder="Search implementations…" value="${escapeHtml(query)}" autofocus /><div class="relationship-options">${additional.map(option).join('') || '<span class="muted tiny">No matching implementations.</span>'}</div>` : ''}</div>`;
}

function openRelationshipFlow(allowEmpty = false) {
  const selected = view().selectedImplementationIds.filter((id) => byId(state.implementations, id));
  if (selected.length < 2 && !allowEmpty) { showToast('Select at least two implementations first.'); return; }
  relationshipDraft = { preselected: selected, picked: [], conflictMembers: [], showAll: allowEmpty, query: '', conflictMenuOpen: false, screen: 'flow' };
  renderRelationshipFlow();
}

function renderRelationshipFlow() {
  if (!relationshipDraft) return;
  relationshipDraft.screen = 'flow';
  modalManager('Conflict / requirement', `<div class="relationship-entry"><div class="split-button"><button class="button danger wide" data-action="open-conflict-builder">Mark conflict</button><button class="button danger split-chevron" data-action="toggle-conflict-menu" aria-label="Conflict options">▾</button><div class="split-menu" ${relationshipDraft.conflictMenuOpen ? '' : 'hidden'}><button data-action="mark-preselected-conflict" data-conflict-mode="all">All preselected</button><button data-action="mark-preselected-conflict" data-conflict-mode="any">Any preselected pair</button></div></div><button class="button primary wide" data-action="open-requirement-builder">Build requirement</button></div>`);
}

function openConflictBuilder() {
  if (!relationshipDraft) return;
  relationshipDraft.screen = 'conflict';
  relationshipDraft.picked = [];
  relationshipDraft.conflictMembers = [];
  relationshipDraft.conflictMenuOpen = false;
  renderConflictBuilder();
}

function renderConflictBuilder() {
  if (!relationshipDraft) return;
  relationshipDraft.screen = 'conflict';
  const picked = relationshipDraft.picked;
  const members = relationshipDraft.conflictMembers;
  const memberChips = members.map((itemId) => `<span class="relationship-chip">${escapeHtml(byId(state.implementations, itemId)?.title || 'Missing')}<button class="remove-chip" data-action="remove-conflict-member" data-id="${itemId}" title="Remove">×</button></span>`).join('') || '<span class="muted tiny">Select implementations above, then add them to this conflict.</span>';
  modalManager('Mark conflict', `<p class="muted">Nothing is selected yet. Your original selection is shown above the divider; select the implementations to add.</p>${relationshipPicker(relationshipDraft.preselected, picked, relationshipDraft.showAll, relationshipDraft.query, 'relationship')}<div class="relationship-add-row"><button class="button secondary compact" data-action="add-conflict-members" ${picked.length ? '' : 'disabled'}>Add to conflict</button></div><div class="conflict-members">${memberChips}</div><div class="relationship-actions"><div class="split-button"><button class="button danger" data-action="mark-selected-conflict" data-conflict-mode="all" ${members.length < 2 ? 'disabled' : ''}>Mark conflict</button><button class="button danger split-chevron" data-action="toggle-conflict-menu" aria-label="Conflict options">▾</button><div class="split-menu" ${relationshipDraft.conflictMenuOpen ? '' : 'hidden'}><button data-action="mark-selected-conflict" data-conflict-mode="all">All</button><button data-action="mark-selected-conflict" data-conflict-mode="any">Any</button><button data-action="open-more-conflict">More…</button></div></div></div><div class="form-actions"><button class="button ghost" data-action="relationship-back">Back</button></div>`);
}

function openMoreConflict() {
  if (!relationshipDraft?.conflictMembers?.length) return;
  relationshipDraft.conflictMenuOpen = false;
  openSelectedConflictDetails(relationshipDraft.conflictMembers, renderConflictBuilder);
}

function openSelectedConflictDetails(ids, returnTo = renderConflictBuilder) {
  const titles = ids.map((itemId) => byId(state.implementations, itemId)?.title || 'Implementation');
  modalCloseReturn = returnTo;
  modalForm('Conflict details', `<div class="form-grid"><label class="field full"><span>Name <small>(optional)</small></span><input name="name" value="${escapeHtml(titles.join(' + '))}" /></label><label class="field full"><span>Explanation <small>(optional)</small></span>${richEditor('', 'Why is this combination invalid?')}</label></div>`, async (form) => {
    const data = new FormData(form); const name = String(data.get('name') || '').trim() || titles.join(' + ');
    state.conflicts.push({ id: id(), name, detailsMarkdown: getRichValue(), themeId: state.activeThemeId, implementationIds: ids, overridesConflictId: null });
    void captureEvent('conflict_created', { member_count: ids.length, scope: 'theme', is_override: false });
    relationshipDraft.conflictMembers = relationshipDraft.conflictMembers.filter((itemId) => !ids.includes(itemId));
    modalCloseReturn = null; closeModal(); render(); markDirty();
    if (returnTo) returnTo();
  });
}

function markSelectedConflict(mode) {
  if (!relationshipDraft?.conflictMembers?.length || relationshipDraft.conflictMembers.length < 2) return;
  const selected = relationshipDraft.conflictMembers;
  if (mode === 'any') {
    for (const pair of allPairs(selected)) state.conflicts.push({ id: id(), name: pair.map((itemId) => byId(state.implementations, itemId)?.title || 'Implementation').join(' ↔ '), detailsMarkdown: '', themeId: state.activeThemeId, implementationIds: pair, overridesConflictId: null });
    void captureEvent('conflict_created', { member_count: selected.length, scope: 'theme', is_override: false, conflict_mode: 'any_pair' });
    relationshipDraft.conflictMembers = [];
    closeModal(); render(); markDirty(); renderConflictBuilder();
    return;
  }
  openSelectedConflictDetails(selected);
}

function openRequirementBuilder() {
  if (!relationshipDraft) return;
  relationshipDraft.conflictMenuOpen = false;
  requirementBuilder = { preselected: [...relationshipDraft.preselected], picked: [], showAll: false, query: '', sides: [[], []] };
  renderRequirementBuilder();
}

function renderRequirementBuilder() {
  if (!requirementBuilder) return;
  const picked = requirementBuilder.picked; const sides = requirementBuilder.sides;
  const side = (items, index) => `<div class="requirement-box">${items.map((id) => `<span class="relationship-chip">${escapeHtml(byId(state.implementations, id)?.title || 'Missing')}<button class="remove-chip" data-action="builder-remove-side" data-side-index="${index}" data-id="${id}" title="Remove">×</button></span>`).join('') || '<span class="muted">No implementations</span>'}<button data-action="builder-add-side" data-side-index="${index}" ${picked.length ? '' : 'disabled'}>Add</button></div>`;
  const valid = sides.slice(0, -1).every((items, index) => items.length && sides[index + 1].length);
  modalManager('Build requirements', `<p class="muted">Select implementations, then add them to a side. Each arrow makes every implementation on its left require every implementation on its right.</p>${relationshipPicker(requirementBuilder.preselected, picked, requirementBuilder.showAll, requirementBuilder.query, 'builder')}<div class="requirement-chain">${sides.map((items, index) => `${index ? '<strong>⇒</strong>' : ''}${side(items, index)}`).join('')}<button class="button secondary compact chain-add" data-action="builder-add-side-chain" ${sides.length >= 4 ? 'disabled' : ''}>+</button></div><div class="form-actions"><button class="button ghost" data-action="relationship-back">Back</button><button class="button primary" data-action="open-requirement-details" ${valid ? '' : 'disabled'}>Save requirements</button></div>`);
}

function openRequirementDetails() {
  modalCloseReturn = renderRequirementBuilder;
  modalForm('Requirement details', `<div class="form-grid"><label class="field full"><span>Name <small>(optional)</small></span><input name="name" /></label><label class="field full"><span>Explanation <small>(optional)</small></span>${richEditor('', 'Why is this requirement needed?')}</label></div>`, async (form) => {
    saveRequirementBuilder({ name: String(new FormData(form).get('name') || '').trim(), detailsMarkdown: getRichValue() });
  });
}

function saveRequirementBuilder(details = {}) {
  const chains = requirementBuilder?.sides?.slice(0, -1).map((from, index) => ({ from, to: requirementBuilder.sides[index + 1] })) || [];
  const edges = requirementEdges(validRequirementChains(chains));
  if (!edges.length) { showToast('Add at least one implementation on both sides of a requirement.'); return; }
  const existing = new Set(requirements().map((item) => `${item.fromImplementationId}:${item.toImplementationId}`));
  let createdCount = 0;
  for (const edge of edges) {
    if (existing.has(`${edge.fromImplementationId}:${edge.toImplementationId}`)) continue;
    requirements().push({ id: id(), ...edge, ...details });
    createdCount += 1;
  }
  if (createdCount) void captureEvent('requirements_created', { requirement_count: createdCount, source: 'builder' });
  const preselected = [...requirementBuilder.preselected];
  requirementBuilder = { preselected, picked: [], showAll: false, query: '', sides: [[], []] };
  modalCloseReturn = null; closeModal(); render(); markDirty(); renderRequirementBuilder();
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
    void captureEvent('saved_view_created', { view_kind: kind, locked_implementation_count: view().lockedImplementationIds.length });
    closeModal(); markDirty(); openSavesManager();
  });
}

function openSavesManager() {
  modalManager('Saved selections and views', `<div class="manager-heading"><p class="callout">Rich is the default. Simple saves only the lock set for future lightweight use.</p><button class="button primary" data-action="save-current-view">+ Save current</button></div>
    <div class="manager-list">${state.savedViews.length ? state.savedViews.map((saved) => `<div class="manager-row"><div><strong>${escapeHtml(saved.name)}</strong><div class="tiny muted">${saved.kind === 'rich' ? 'Rich view' : 'Simple selection'} · ${escapeHtml(themeName(saved.themeId))} · ${saved.lockedImplementationIds.length} locked</div></div><div class="manager-row-actions"><button class="button secondary" data-action="load-view" data-id="${saved.id}">Load</button><button class="button danger" data-action="delete-view" data-id="${saved.id}">Delete</button></div></div>`).join('') : '<p class="muted">No saved views yet.</p>'}</div>`);
}

function openCompareViews() {
  const options = state.savedViews.map((saved) => `<option value="${saved.id}">${escapeHtml(saved.name)}</option>`).join('');
  modalForm('Compare saved views', `<div class="form-grid"><label class="field"><span>Earlier view</span><select name="left">${options}</select></label><label class="field"><span>Later view</span><select name="right">${options}</select></label></div>`, async (form) => {
    const data = new FormData(form);
    const left = byId(state.savedViews, String(data.get('left')));
    const right = byId(state.savedViews, String(data.get('right')));
    if (!left || !right || left.id === right.id) throw new Error('Choose two different views.');
    const additions = right.lockedImplementationIds.filter((itemId) => !left.lockedImplementationIds.includes(itemId));
    const removals = left.lockedImplementationIds.filter((itemId) => !right.lockedImplementationIds.includes(itemId));
    const titleList = (ids) => ids.map((itemId) => byId(state.implementations, itemId)?.title || 'Missing implementation');
    const completed = state.conflicts.filter((conflict) => conflict.implementationIds.every((itemId) => right.lockedImplementationIds.includes(itemId)) && !conflict.implementationIds.every((itemId) => left.lockedImplementationIds.includes(itemId)));
    modalManager(`${left.name} to ${right.name}`, `<div class="comparison-grid"><section><h3>Added (${additions.length})</h3>${titleList(additions).map((title) => `<p>${escapeHtml(title)}</p>`).join('') || '<p class="muted">Nothing added.</p>'}</section><section><h3>Removed (${removals.length})</h3>${titleList(removals).map((title) => `<p>${escapeHtml(title)}</p>`).join('') || '<p class="muted">Nothing removed.</p>'}</section></div><section><h3>Newly completed conflicts (${completed.length})</h3>${completed.map((conflict) => `<p>${escapeHtml(conflict.name)}</p>`).join('') || '<p class="muted">None.</p>'}</section><button class="button ghost" data-action="manage-saves">Back</button>`);
  }, 'Compare');
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

async function deleteImplementationAttachments(implementation) {
  const attachments = implementation?.attachments || [];
  await Promise.allSettled(attachments.map((attachment) => {
    const storage = attachment.storageName || attachment.id;
    if (!storage) return Promise.resolve();
    const path = storageMode === 'cloud'
      ? `/api/projects/${encodeURIComponent(currentProjectId)}/attachments/${encodeURIComponent(storage)}`
      : `/api/attachments/${encodeURIComponent(storage)}`;
    return api(path, { method: 'DELETE' });
  }));
}

function removeImplementation(implementationId, ask = true) {
  const implementation = byId(state.implementations, implementationId);
  if (!implementation || (ask && !confirm(`Delete “${implementation.title}” everywhere?`))) return false;
  void deleteImplementationAttachments(implementation);
  state.implementations = state.implementations.filter((item) => item.id !== implementationId);
  state.conflicts = state.conflicts.map((conflict) => ({ ...conflict, implementationIds: conflict.implementationIds.filter((id) => id !== implementationId) })).filter((conflict) => conflict.implementationIds.length >= 2);
  state.requirements = requirements().filter((requirement) => requirement.fromImplementationId !== implementationId && requirement.toImplementationId !== implementationId);
  state.savedViews.forEach((saved) => { saved.lockedImplementationIds = saved.lockedImplementationIds.filter((id) => id !== implementationId); if (saved.richView) saved.richView.lockedImplementationIds = saved.richView.lockedImplementationIds.filter((id) => id !== implementationId); });
  Object.values(state.uiByTheme).forEach((item) => {
    for (const key of ['lockedImplementationIds', 'manuallyLockedImplementationIds', 'selectedImplementationIds', 'visibleImplementationIds', 'previousVisibleImplementationIds', 'expandedImplementationIds', 'knownImplementationIds']) item[key] = (item[key] || []).filter((id) => id !== implementationId);
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
  else view().lockedImplementationIds = normalizeLockedWithRequirements(conflictsForTheme(), requirements(), saved.lockedImplementationIds, implementationsForTheme().map((item) => item.id));
  focusedConflictId = null; currentInspectorId = null;
  closeModal(); render(); markDirty();
}

async function uploadAttachment(input) {
  const file = input.files?.[0];
  const implementationId = input.dataset.implementationId;
  if (!file || !implementationId) return;
  try {
    setStatus('Uploading attachment…');
    const attachmentPath = storageMode === 'cloud' ? `/api/projects/${encodeURIComponent(currentProjectId)}/attachments` : '/api/attachments';
    const attachment = await api(`${attachmentPath}?filename=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
    const implementation = byId(state.implementations, implementationId);
    implementation.attachments ||= [];
    implementation.attachments.push(attachment);
    void captureEvent('attachment_uploaded', { storage_mode: storageMode, mime_type: file.type || 'application/octet-stream', size_bucket: file.size < 1024 * 1024 ? 'under_1mb' : file.size < 10 * 1024 * 1024 ? '1mb_to_10mb' : 'over_10mb' });
    render(); markDirty();
  } catch (error) { showToast(error.message); }
}

async function applyImportedArchive(imported, label) {
  const candidate = validateProjectDocument(imported);
  await checkpointBeforeImport(`Before importing ${label}`);
  const archived = importedAttachments(imported);
  const uploaded = [];
  try {
    for (const entry of archived) {
      const file = new File([entry.blob], entry.name, { type: entry.mime || 'application/octet-stream' });
      const attachmentPath = storageMode === 'cloud' ? `/api/projects/${encodeURIComponent(currentProjectId)}/attachments` : '/api/attachments';
      const attachment = await api(`${attachmentPath}?filename=${encodeURIComponent(entry.name)}`, { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
      uploaded.push(attachment);
      for (const implementation of candidate.implementations) {
        implementation.attachments = (implementation.attachments || []).map((reference) => {
          const referenceId = reference.id || reference.storageName;
          return referenceId === entry.id ? attachment : reference;
        });
      }
    }
    state = candidate;
    void captureEvent('project_imported', { import_format: label === 'project directory' ? 'directory' : 'archive', attachment_count: archived.length });
    closeModal();
    render();
    markDirty();
    showToast(`Imported ${label}.`);
  } catch (error) {
    await Promise.allSettled(uploaded.map((attachment) => api(storageMode === 'cloud' ? `/api/projects/${encodeURIComponent(currentProjectId)}/attachments/${encodeURIComponent(attachment.storageName)}` : `/api/attachments/${encodeURIComponent(attachment.storageName)}`, { method: 'DELETE' })));
    throw error;
  }
}

function restoreHistory(direction) {
  const source = direction === 'undo' ? undoStack : redoStack;
  const target = direction === 'undo' ? redoStack : undoStack;
  const snapshot = source.pop();
  if (!snapshot) return;
  target.push(structuredClone(state));
  state = validateProjectDocument(snapshot);
  historyBaseline = JSON.stringify(state);
  closeModal();
  render();
  markDirty(false);
  showToast(direction === 'undo' ? 'Undid the last change.' : 'Redid the change.');
}

function handleAction(target) {
  const action = target.dataset.action;
  const itemId = target.dataset.id;
  if (!action) return;
  if (action === 'cycle-color-mode') { cycleColorMode(); return; }
  if (action === 'undo') { restoreHistory('undo'); return; }
  if (action === 'redo') { restoreHistory('redo'); return; }
  if (action === 'continue-guest') { continueAsGuest(); return; }
  if (action === 'sign-in') {
    if (storageMode === 'guest' && state) saveGuestState(state);
    if (!clerk) {
      if (clerkStatus === 'error') {
        authenticationError = '';
        initializeClerk().then(() => handleAction(target)).catch((error) => showToast(`Sign-in is unavailable: ${error.message}`));
        showToast('Retrying sign-in…');
        return;
      }
      showToast(authenticationError ? `Sign-in is unavailable: ${authenticationError}` : 'Sign-in is still loading. Please try again in a moment.');
      return;
    }
    try {
      // Redirecting does not require Clerk's optional in-page UI bundle. This
      // also lets a brand-new production instance complete its first-user flow.
      Promise.resolve(clerk.redirectToSignIn({ returnBackUrl: window.location.href }))
        .catch((error) => showToast(`Sign-in is unavailable: ${error.message}`));
      showToast('Redirecting to sign-in…');
    } catch (error) { showToast(`Sign-in is unavailable: ${error.message}`); }
    return;
  }
  if (action === 'sync-guest') { moveGuestProjectToCloud(); return; }
  if (action === 'retry-cloud-connection') { retryCloudConnection(); return; }
  if (action === 'resolve-cloud-conflict') { openCloudConflictModal(); return; }
  if (action === 'download-conflict-copy' && pendingSaveConflict) { downloadStateCopy(pendingSaveConflict.snapshot); return; }
  if (action === 'use-server-copy' && pendingSaveConflict?.server) {
    state = validateProjectDocument(pendingSaveConflict.server);
    currentRevision = Number(pendingSaveConflict.error.payload?.revision || currentRevision);
    lastSavedSnapshot = projectContentFingerprint(state);
    pendingSaveConflict = null;
    closeModal();
    configureSaveCoordinator();
    render();
    return;
  }
  if (action === 'force-save-local' && pendingSaveConflict) {
    const conflict = pendingSaveConflict;
    api(storageMode === 'cloud' ? `/api/projects/${encodeURIComponent(currentProjectId)}/state` : '/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: conflict.snapshot, baseRevision: conflict.error.payload?.revision, force: true }) })
      .then((saved) => {
        pendingSaveConflict = null;
        closeModal();
        openWorkbench({ state: saved.state, path: projectPath, projectId: currentProjectId, revision: saved.revision });
        showToast('Your local copy replaced the saved copy.');
      })
      .catch((error) => showToast(error.message));
    return;
  }
  if (action === 'restore-draft' && pendingRecoveredDraft) {
    state = validateProjectDocument(pendingRecoveredDraft);
    pendingRecoveredDraft = null;
    closeModal();
    render();
    markDirty();
    return;
  }
  if (action === 'download-recovered-draft' && pendingRecoveredDraft) { downloadStateCopy(pendingRecoveredDraft, 'recovered-draft'); return; }
  if (action === 'discard-recovered-draft') {
    pendingRecoveredDraft = null;
    saveCoordinator?.journal?.clear();
    closeModal();
    return;
  }
  if (action === 'sign-out') { openSignOutMenu(); return; }
  if (action === 'open-sign-out-menu') { openSignOutMenu(); return; }
  if (action === 'choose-sign-out-copy') { openSignOutMenu(target.dataset.removeBrowserCopy === 'true'); return; }
  if (action === 'confirm-sign-out') { signOutAndReturnToBrowser({ removeBrowserCopy: target.dataset.removeBrowserCopy === 'true' }); return; }
  if (!state) { showToast('The workbench has not finished starting. Please reload this page.'); return; }
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
  else if (action === 'close-modal') dismissModal();
  else if (action === 'create-menu') openCreateMenu();
  else if (action === 'open-more-menu') openMoreMenu();
  else if (action === 'open-command-palette') openCommandPalette();
  else if (action === 'open-display-settings') openDisplaySettings();
  else if (action === 'toggle-idea-sort-direction' || action === 'toggle-sort-direction') { v.ideaSortDirection = v.ideaSortDirection === 'desc' ? 'asc' : 'desc'; renderFilters(); renderBoard(); markDirty(); }
  else if (action === 'toggle-board-density') {
    boardDensity = boardDensity === 'compact' ? 'detailed' : 'compact';
    localStorage.setItem('ideation-workbench:board-density', boardDensity);
    closeModal();
    renderBoard();
    showToast(`${boardDensity === 'compact' ? 'Compact' : 'Detailed'} board density enabled.`);
  }
  else if (action === 'open-mobile-filters') openMobileFilters();
  else if (action === 'clear-mobile-filters') { view().ideaGroupFilterIds = []; openMobileFilters(); }
  else if (action === 'apply-mobile-filters') {
    v.ideaGroupFilterIds = $$('[data-mobile-group-filter]:checked', modalBody).map((input) => input.value);
    v.showExcluded = Boolean($('[data-mobile-show-excluded]', modalBody)?.checked);
    v.ideaSort = String($('[data-mobile-idea-sort]', modalBody)?.value || v.ideaSort);
    closeModal();
    render();
    markDirty();
  }
  else if (action === 'open-relationship-flow') openRelationshipFlow();
  else if (action === 'open-empty-relationship-flow') openRelationshipFlow(true);
  else if (action === 'open-conflict-builder') openConflictBuilder();
  else if (action === 'relationship-toggle') { relationshipDraft.picked = relationshipDraft.picked.includes(itemId) ? relationshipDraft.picked.filter((id) => id !== itemId) : [...relationshipDraft.picked, itemId]; renderConflictBuilder(); }
  else if (action === 'relationship-more') { relationshipDraft.showAll = !relationshipDraft.showAll; renderConflictBuilder(); }
  else if (action === 'toggle-conflict-menu') { relationshipDraft.conflictMenuOpen = !relationshipDraft.conflictMenuOpen; relationshipDraft.screen === 'flow' ? renderRelationshipFlow() : renderConflictBuilder(); }
  else if (action === 'add-conflict-members') { relationshipDraft.conflictMembers = unique([...relationshipDraft.conflictMembers, ...relationshipDraft.picked]); relationshipDraft.picked = []; renderConflictBuilder(); }
  else if (action === 'remove-conflict-member') { relationshipDraft.conflictMembers = relationshipDraft.conflictMembers.filter((id) => id !== itemId); renderConflictBuilder(); }
  else if (action === 'mark-selected-conflict') markSelectedConflict(target.dataset.conflictMode);
  else if (action === 'mark-preselected-conflict') { relationshipDraft.conflictMembers = [...relationshipDraft.preselected]; relationshipDraft.conflictMenuOpen = false; markSelectedConflict(target.dataset.conflictMode); }
  else if (action === 'open-more-conflict') openMoreConflict();
  else if (action === 'relationship-back') renderRelationshipFlow();
  else if (action === 'open-requirement-builder') openRequirementBuilder();
  else if (action === 'builder-toggle') { requirementBuilder.picked = requirementBuilder.picked.includes(itemId) ? requirementBuilder.picked.filter((id) => id !== itemId) : [...requirementBuilder.picked, itemId]; renderRequirementBuilder(); }
  else if (action === 'builder-more') { requirementBuilder.showAll = !requirementBuilder.showAll; renderRequirementBuilder(); }
  else if (action === 'builder-add-side') { const side = requirementBuilder.sides[Number(target.dataset.sideIndex)]; if (side) { requirementBuilder.sides[Number(target.dataset.sideIndex)] = unique([...side, ...requirementBuilder.picked]); requirementBuilder.picked = []; renderRequirementBuilder(); } }
  else if (action === 'builder-remove-side') { const index = Number(target.dataset.sideIndex); requirementBuilder.sides[index] = requirementBuilder.sides[index].filter((id) => id !== itemId); renderRequirementBuilder(); }
  else if (action === 'builder-add-side-chain') { if (requirementBuilder.sides.length < 4) requirementBuilder.sides.push([]); renderRequirementBuilder(); }
  else if (action === 'open-requirement-details') openRequirementDetails();
  else if (action === 'create-idea') { closeModal(); openIdeaForm(); }
  else if (action === 'create-implementation') { closeModal(); openImplementationForm(); }
  else if (action === 'create-theme') { closeModal(); openThemeForm(null, false); }
  else if (action === 'create-idea-group') { closeModal(); openGroupForm('idea'); }
  else if (action === 'create-implementation-group') { closeModal(); openGroupForm('implementation'); }
  else if (action === 'add-idea') { closeModal(); openIdeaForm(); }
  else if (action === 'edit-idea') { closeModal(); openIdeaForm(itemId); }
  else if (action === 'delete-idea') deleteIdea(itemId);
  else if (action === 'add-implementation') { closeModal(); openImplementationForm(null, target.dataset.ideaId || null); }
  else if (action === 'edit-implementation') openImplementationRelationships(itemId);
  else if (action === 'open-implementation-form') { closeModal(); openImplementationForm(itemId); }
  else if (action === 'delete-implementation') { if (removeImplementation(itemId)) { render(); markDirty(); } }
  else if (action === 'toggle-idea-details') { v.expandedIdeaIds = v.expandedIdeaIds.includes(itemId) ? v.expandedIdeaIds.filter((id) => id !== itemId) : [...v.expandedIdeaIds, itemId]; render(); markDirty(); }
  else if (action === 'toggle-impl-details') { v.expandedImplementationIds = v.expandedImplementationIds.includes(itemId) ? v.expandedImplementationIds.filter((id) => id !== itemId) : [...v.expandedImplementationIds, itemId]; render(); markDirty(); }
  else if (action === 'hide-implementation') { v.previousVisibleImplementationIds = [...v.visibleImplementationIds]; v.visibleImplementationIds = v.visibleImplementationIds.filter((id) => id !== itemId); render(); markDirty(); }
  else if (action === 'show-implementation') { v.previousVisibleImplementationIds = [...v.visibleImplementationIds]; v.visibleImplementationIds = unique([...v.visibleImplementationIds, itemId]); render(); markDirty(); }
  else if (action === 'filter-idea-group-only' || action === 'group-only') { v.ideaGroupFilterIds = target.dataset.id === 'all' ? [] : [target.dataset.id]; render(); markDirty(); }
  else if (action === 'toggle-idea-group-filter' || action === 'group-toggle') { const groupId = target.dataset.id; v.ideaGroupFilterIds = v.ideaGroupFilterIds.includes(groupId) ? v.ideaGroupFilterIds.filter((id) => id !== groupId) : [...v.ideaGroupFilterIds, groupId]; renderFilters(); $('#group-filter').open = true; renderBoard(); markDirty(); }
  else if (action === 'show-all') { v.previousVisibleImplementationIds = [...v.visibleImplementationIds]; v.visibleImplementationIds = implementationsForTheme().map((item) => item.id); render(); markDirty(); }
  else if (action === 'hide-all') { v.previousVisibleImplementationIds = [...v.visibleImplementationIds]; v.visibleImplementationIds = []; render(); markDirty(); }
  else if (action === 'restore-visible') { const previous = [...v.previousVisibleImplementationIds]; v.previousVisibleImplementationIds = [...v.visibleImplementationIds]; v.visibleImplementationIds = previous; render(); markDirty(); }
  else if (action === 'toggle-selection') { v.selectedImplementationIds = v.selectedImplementationIds.includes(itemId) ? v.selectedImplementationIds.filter((id) => id !== itemId) : [...v.selectedImplementationIds, itemId]; render(); markDirty(); }
  else if (action === 'lock-selected') {
    const selected = v.selectedImplementationIds;
    const allManual = selected.length && selected.every((id) => v.manuallyLockedImplementationIds.includes(id));
    let rejectedCount = 0;
    if (allManual) {
      v.manuallyLockedImplementationIds = v.manuallyLockedImplementationIds.filter((id) => !selected.includes(id));
    } else {
      const manual = [...v.manuallyLockedImplementationIds];
      const rejected = [];
      for (const candidateId of selected) {
        if (manual.includes(candidateId)) continue;
        const proposal = lockWithRequirements(conflictsForTheme(), requirements(), normalizeLockedWithRequirements(conflictsForTheme(), requirements(), manual, implementationsForTheme().map((item) => item.id)), candidateId, implementationsForTheme().map((item) => item.id));
        if (proposal.missingIds.length || proposal.completedConflicts.length) rejected.push(byId(state.implementations, candidateId)?.title || 'Implementation');
        else manual.push(candidateId);
      }
      v.manuallyLockedImplementationIds = manual;
      rejectedCount = rejected.length;
      if (rejected.length) showToast(`Could not lock: ${rejected.join(', ')}. Check its conflicts or requirements.`);
    }
    v.selectedImplementationIds = [];
    syncViewWithTheme(v);
    void captureEvent('decision_lock_updated', { action: allManual ? 'unlock' : 'lock', locked_implementation_count: v.lockedImplementationIds.length, rejected_implementation_count: rejectedCount });
    render(); markDirty();
  }
  else if (action === 'clear-locks') { v.manuallyLockedImplementationIds = []; v.lockedImplementationIds = []; v.selectedImplementationIds = []; render(); markDirty(); }
  else if (action === 'clear-selection') { v.selectedImplementationIds = []; render(); markDirty(); }
  else if (action === 'open-inspector') { currentInspectorIdeaId = null; currentInspectorId = itemId; renderInspector(true); }
  else if (action === 'open-idea-inspector') { currentInspectorId = null; currentInspectorIdeaId = itemId; renderInspector(true); }
  else if (action === 'close-inspector') { currentInspectorId = null; currentInspectorIdeaId = null; renderInspector(); }
  else if (action === 'focus-conflict') { focusedConflictId = itemId; closeModal(); render(); }
  else if (action === 'clear-conflict-focus') { focusedConflictId = null; renderBoard(); }
  else if (action === 'choose-theme') openThemePicker();
  else if (action === 'select-theme') { state.activeThemeId = itemId; currentInspectorId = null; focusedConflictId = null; closeModal(); render(); markDirty(); }
  else if (action === 'use-cloud-project') {
    const cloud = pendingCloudConflict;
    pendingCloudConflict = null;
    storageMode = 'cloud';
    closeModal();
    openWorkbench(cloud);
    showToast('Using your existing private cloud project.');
  }
  else if (action === 'replace-cloud-project') { closeModal(); uploadBrowserProjectToCloud(structuredClone(state), 'This browser project replaced the cloud project.'); }
  else if (action === 'manage-structure') openStructureManager();
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
  else if (action === 'manage-requirements') openRequirementsManager();
  else if (action === 'add-requirement') { closeModal(); openRequirementForm(); }
  else if (action === 'edit-requirement') { closeModal(); openRequirementForm(itemId); }
  else if (action === 'add-requirement-for-implementation') { closeModal(); openRequirementForm(null, itemId, itemId); }
  else if (action === 'edit-relationship-requirement') { const returnId = target.dataset.returnId; closeModal(); openRequirementForm(itemId, null, returnId); }
  else if (action === 'delete-requirement') { const requirement = byId(requirements(), itemId); if (requirement && confirm('Delete this requirement?')) { state.requirements = requirements().filter((item) => item.id !== itemId); render(); markDirty(); openRequirementsManager(); } }
  else if (action === 'add-conflict') { closeModal(); openConflictForm(); }
  else if (action === 'edit-conflict') { closeModal(); openConflictForm(itemId); }
  else if (action === 'add-conflict-for-implementation') { closeModal(); openConflictForm(null, null, itemId, itemId); }
  else if (action === 'edit-relationship-conflict') { const returnId = target.dataset.returnId; closeModal(); openConflictForm(itemId, null, null, returnId); }
  else if (action === 'delete-conflict') { const conflict = byId(state.conflicts, itemId); if (conflict && confirm(`Delete conflict “${conflict.name}”?`)) { state.conflicts = state.conflicts.filter((item) => item.id !== itemId); render(); markDirty(); openConflictManager(); } }
  else if (action === 'override-conflict') { closeModal(); openConflictForm(null, itemId); }
  else if (action === 'hide-conflict') { const theme = activeTheme(); theme.hiddenInheritedConflictIds = unique([...(theme.hiddenInheritedConflictIds || []), itemId]); render(); markDirty(); openConflictManager(); }
  else if (action === 'unhide-conflict') { const theme = activeTheme(); theme.hiddenInheritedConflictIds = (theme.hiddenInheritedConflictIds || []).filter((id) => id !== itemId); render(); markDirty(); openConflictManager(); }
  else if (action === 'hide-inherited') { const theme = activeTheme(); theme.hiddenInheritedImplementationIds = unique([...(theme.hiddenInheritedImplementationIds || []), itemId]); currentInspectorId = null; render(); markDirty(); }
  else if (action === 'unhide-inherited') { const theme = activeTheme(); theme.hiddenInheritedImplementationIds = (theme.hiddenInheritedImplementationIds || []).filter((id) => id !== itemId); render(); markDirty(); openStructureManager(); }
  else if (action === 'make-direct') { const implementation = byId(state.implementations, itemId); implementation.themeIds = unique([...implementation.themeIds, state.activeThemeId]); activeTheme().hiddenInheritedImplementationIds = (activeTheme().hiddenInheritedImplementationIds || []).filter((id) => id !== itemId); render(); markDirty(); }
  else if (action === 'manage-saves') openSavesManager();
  else if (action === 'compare-views') openCompareViews();
  else if (action === 'save-current-view') { closeModal(); openSaveViewForm(); }
  else if (action === 'load-view') loadSavedView(itemId);
  else if (action === 'delete-view') { state.savedViews = state.savedViews.filter((item) => item.id !== itemId); markDirty(); openSavesManager(); }
  else if (action === 'open-share-menu') openShareMenu();
  else if (action === 'create-project-share') createProjectShare(target.dataset.shareMode, Number(target.dataset.expiryDays || 0));
  else if (action === 'revoke-project-share') {
    if (!confirm('Revoke this share link? Anyone using it will immediately lose access.')) return;
    api(`/api/projects/${encodeURIComponent(currentProjectId)}/shares/${encodeURIComponent(itemId)}`, { method: 'DELETE' })
      .then(() => { showToast('Share link revoked.'); openShareMenu(); })
      .catch((error) => showToast(error.message));
  }
  else if (action === 'copy-share-link') copyShareLink();
  else if (action === 'open-export-menu') openExportMenu();
  else if (action === 'open-import-menu') openImportMenu();
  else if (action === 'export-project-zip') {
    closeModal();
    setStatus('Preparing complete archiveâ€¦');
    downloadProjectZip(state).then(() => { void captureEvent('project_exported', { export_format: 'zip' }); setStatus('Saved'); showToast('Portable ZIP exported with attachments.'); }).catch((error) => { setStatus('Export failed'); showToast(error.message); });
  }
  else if (action === 'export-project-directory') {
    closeModal(); exportProjectDirectory(state).then(() => { void captureEvent('project_exported', { export_format: 'directory' }); showToast('Project directory exported.'); }).catch((error) => showToast(error.message));
  }
  else if (action === 'import-project-portable') {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.zip,.json,application/zip,application/json';
    input.onchange = async () => { const file = input.files?.[0]; if (!file) return; try { await applyImportedArchive(await importProjectFile(file), file.name); } catch (error) { showToast(error.message); } };
    input.click();
  }
  else if (action === 'import-project-directory') {
    importProjectDirectory().then((imported) => applyImportedArchive(imported, 'project directory')).catch((error) => showToast(error.message));
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
    void captureEvent('project_exported', { export_format: 'markdown' });
    showToast('Project exported as markdown.');
  }
  else if (action === 'project-menu') openProjectMenu();
  else if (action === 'open-project-library') openProjectLibrary();
  else if (action === 'open-project-history') openProjectHistory();
  else if (action === 'create-project-checkpoint') {
    const label = prompt('Checkpoint name', 'Checkpoint');
    if (!label?.trim()) return;
    saveState()
      .then(() => saveCoordinator?.flush())
      .then(() => api(`/api/projects/${encodeURIComponent(currentProjectId)}/revisions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: label.trim() }) }))
      .then(() => { showToast('Checkpoint saved.'); openProjectHistory(); })
      .catch((error) => showToast(error.message));
  }
  else if (action === 'restore-project-revision') {
    if (!confirm('Restore this revision as the current project? The present version remains in history.')) return;
    checkpointBeforeImport('Before history restore')
      .then(() => api(`/api/projects/${encodeURIComponent(currentProjectId)}/revisions/${encodeURIComponent(itemId)}`))
      .then((revision) => { state = validateProjectDocument(revision.state); closeModal(); render(); markDirty(); showToast(`Restored revision ${revision.revision}.`); })
      .catch((error) => showToast(error.message));
  }
  else if (action === 'new-project') openNewProjectForm();
  else if (action === 'switch-project') switchProject(itemId).catch((error) => showToast(error.message));
  else if (action === 'duplicate-project') {
    api(`/api/projects/${encodeURIComponent(itemId)}`).then((result) => {
      const duplicate = structuredClone(result.state);
      duplicate.meta.id = id();
      duplicate.meta.name = `${result.project.name} copy`;
      duplicate.meta.createdAt = new Date().toISOString();
      duplicate.meta.updatedAt = duplicate.meta.createdAt;
      return api('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: duplicate }) });
    }).then(() => { showToast('Project duplicated.'); openProjectLibrary(); }).catch((error) => showToast(error.message));
  }
  else if (action === 'archive-project') {
    if (!confirm('Archive this project? You can restore it later.')) return;
    api(`/api/projects/${encodeURIComponent(itemId)}`, { method: 'DELETE' }).then(() => { showToast('Project archived.'); openProjectLibrary(); }).catch((error) => showToast(error.message));
  }
  else if (action === 'restore-project') {
    api(`/api/projects/${encodeURIComponent(itemId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: false }) }).then(() => { showToast('Project restored.'); openProjectLibrary(); }).catch((error) => showToast(error.message));
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
        await checkpointBeforeImport(`Before importing ${file.name}`);
        parseImportMarkdown(text, state);
        void captureEvent('project_imported', { import_format: 'markdown', attachment_count: 0 });
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
  else if (action === 'rename-project-inline') startProjectRename();
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
      const deletePath = storageMode === 'cloud' ? `/api/projects/${encodeURIComponent(currentProjectId)}/attachments/${encodeURIComponent(storage)}` : `/api/attachments/${encodeURIComponent(storage)}`;
      api(deletePath, { method: 'DELETE' }).then(() => {
        implementation.attachments = (implementation.attachments || []).filter((item) => item.storageName !== storage);
        render(); markDirty();
      }).catch((error) => showToast(error.message));
    }
  }
}

document.addEventListener('click', (event) => {
  const groupFilter = $('#group-filter');
  if (groupFilter?.open && !event.target.closest('#group-filter')) groupFilter.open = false;
  if (relationshipDraft?.conflictMenuOpen && !event.target.closest('.split-button')) {
    relationshipDraft.conflictMenuOpen = false;
    if (modal.open) (relationshipDraft.screen === 'flow' ? renderRelationshipFlow : renderConflictBuilder)();
  }
  const actionTarget = event.target.closest('[data-action]');
  if (actionTarget) {
    handleAction(actionTarget);
    return;
  }
  if ((currentInspectorId || currentInspectorIdeaId) && !event.target.closest('#inspector') && !event.target.closest('.impl-row') && !event.target.closest('.idea-card') && !event.target.closest('#modal')) {
    currentInspectorId = null;
    currentInspectorIdeaId = null;
    renderInspector();
  }
});

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    openCommandPalette();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !event.target.closest('input, textarea, [contenteditable="true"]') && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    restoreHistory(event.shiftKey ? 'redo' : 'undo');
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !event.target.closest('input, textarea, [contenteditable="true"]') && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    restoreHistory('redo');
    return;
  }
  if (event.ctrlKey && event.key === 'Enter') {
    const inspectorForm = $('#inspector-form');
    const ideaInspectorForm = $('#idea-inspector-form');
    const modalForm = modal.querySelector('form');
    if (ideaInspectorForm && ideaInspectorForm.contains(event.target)) {
      event.preventDefault();
      const idea = byId(state.ideas, currentInspectorIdeaId);
      if (!idea) return;
      const formData = new FormData(ideaInspectorForm);
      idea.title = String(formData.get('title') || '').trim() || idea.title;
      idea.detailsMarkdown = getRichValue($('#inspector'));
      render(); markDirty();
    } else if (inspectorForm && inspectorForm.contains(event.target)) {
      event.preventDefault();
      const implementation = byId(state.implementations, currentInspectorId);
      if (!implementation) return;
      const formData = new FormData(inspectorForm);
      implementation.title = String(formData.get('title') || '').trim() || implementation.title;
      implementation.detailsMarkdown = getRichValue($('#inspector'));
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

modal.addEventListener('cancel', (event) => {
  event.preventDefault();
  dismissModal();
});

$('#board-controls').addEventListener('input', (event) => {
  if (event.target.id === 'search-input') { view().search = event.target.value; renderBoard(); markDirty(); }
  if (event.target.id === 'show-excluded') { view().showExcluded = event.target.checked; renderBoard(); markDirty(); }
});
$('#board-controls').addEventListener('change', (event) => {
  if (event.target.id === 'show-excluded') { view().showExcluded = event.target.checked; renderBoard(); markDirty(); }
  if (event.target.id === 'idea-sort') { view().ideaSort = event.target.value; renderBoard(); markDirty(); }
});
$('#inspector').addEventListener('submit', (event) => {
  if (!['inspector-form', 'idea-inspector-form'].includes(event.target.id)) return;
  event.preventDefault();
  if (event.target.id === 'idea-inspector-form') {
    const idea = byId(state.ideas, currentInspectorIdeaId);
    if (!idea) return;
    const formData = new FormData(event.target);
    idea.title = String(formData.get('title') || '').trim() || idea.title;
    idea.detailsMarkdown = getRichValue($('#inspector'));
    render(); markDirty();
    return;
  }
  const implementation = byId(state.implementations, currentInspectorId);
  const formData = new FormData(event.target);
  implementation.title = String(formData.get('title') || '').trim() || implementation.title;
  implementation.detailsMarkdown = getRichValue($('#inspector'));
  render(); markDirty();
});
$('#inspector').addEventListener('change', (event) => { if (event.target.id === 'attachment-input') uploadAttachment(event.target); });
modal.addEventListener('input', (event) => {
  const kind = event.target.dataset.relationshipSearch;
  if (kind === 'relationship' && relationshipDraft) { relationshipDraft.query = event.target.value; renderConflictBuilder(); }
  if (kind === 'builder' && requirementBuilder) { requirementBuilder.query = event.target.value; renderRequirementBuilder(); }
  if (event.target.matches('[data-command-search]')) {
    const query = event.target.value.trim().toLowerCase();
    $$('.command-list button', modalBody).forEach((button) => { button.hidden = Boolean(query && !button.textContent.toLowerCase().includes(query)); });
  }
  if (!kind && event.target.closest('#modal-form')) modalDirty = true;
});
modal.addEventListener('click', (event) => { if (event.target === modal) dismissModal(); });
$('#board').addEventListener('pointerdown', beginBoardPointer);
$('#board').addEventListener('keydown', (event) => {
  if (!event.target.closest('.drag-handle') || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  keyboardReorderBoardItem(event.target, ['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 1);
});
document.addEventListener('pointermove', moveBoardDrag, { passive: false });
document.addEventListener('pointerup', (event) => finishBoardDrag(event));
document.addEventListener('pointercancel', (event) => finishBoardDrag(event, true));
window.addEventListener('beforeunload', () => { if (storageMode === 'guest' && state) saveGuestState(state); });

boot();
