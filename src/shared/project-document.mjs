export const PROJECT_DOCUMENT_VERSION = 2;
export const MAX_PROJECT_DOCUMENT_BYTES = 4 * 1024 * 1024;

export class ProjectValidationError extends Error {
  constructor(issues) {
    super(issues[0] || 'Invalid project document.');
    this.name = 'ProjectValidationError';
    this.issues = issues;
  }
}

const arrays = [
  'themes',
  'ideaGroups',
  'implementationGroups',
  'ideas',
  'implementations',
  'groupLinks',
  'conflicts',
  'requirements',
  'savedViews',
];

function clone(value) {
  return structuredClone(value);
}

function string(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function stringIds(value) {
  return Array.isArray(value) ? [...new Set(value.filter((item) => typeof item === 'string' && item))] : [];
}

function legacyHtmlToMarkdown(value = '') {
  return string(value)
    .replace(/<pre>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n')
    .replace(/<h([1-6])>([\s\S]*?)<\/h\1>/gi, (_, level, content) => `\n${'#'.repeat(Number(level))} ${content.trim()}\n`)
    .replace(/<blockquote>([\s\S]*?)<\/blockquote>/gi, '\n> $1\n')
    .replace(/<li>([\s\S]*?)<\/li>/gi, '- $1\n')
    .replace(/<p>([\s\S]*?)<\/p>/gi, '\n\n$1\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<s>([\s\S]*?)<\/s>/gi, '~~$1~~')
    .replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeMarkdownItem(item, fallbackTitle, index) {
  const normalized = {
    ...item,
    id: string(item?.id),
    detailsMarkdown: string(item?.detailsMarkdown) || legacyHtmlToMarkdown(item?.detailsHtml),
  };
  delete normalized.detailsHtml;
  if (fallbackTitle) normalized.title = string(item?.title, fallbackTitle).slice(0, 240);
  if (index !== undefined) normalized.sortOrder = Number.isFinite(item?.sortOrder) ? item.sortOrder : index;
  return normalized;
}

function normalizeView(value = {}) {
  return {
    lockedImplementationIds: stringIds(value.lockedImplementationIds),
    visibleImplementationIds: stringIds(value.visibleImplementationIds),
    previousVisibleImplementationIds: stringIds(value.previousVisibleImplementationIds),
    manuallyLockedImplementationIds: stringIds(value.manuallyLockedImplementationIds || value.lockedImplementationIds),
    selectedImplementationIds: stringIds(value.selectedImplementationIds),
    expandedIdeaIds: stringIds(value.expandedIdeaIds),
    expandedImplementationIds: stringIds(value.expandedImplementationIds),
    showExcluded: value.showExcluded !== false,
    search: string(value.search),
    ideaGroupFilterIds: stringIds(value.ideaGroupFilterIds || (value.ideaGroupFilter && value.ideaGroupFilter !== 'all' ? [value.ideaGroupFilter] : [])),
    knownImplementationIds: stringIds(value.knownImplementationIds),
    ideaSort: ['manual', 'implementations', 'locked', 'conflicts'].includes(value.ideaSort) ? value.ideaSort : 'manual',
    ideaSortDirection: value.ideaSortDirection === 'desc' ? 'desc' : 'asc',
  };
}

export function migrateProjectDocument(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProjectValidationError(['Project document must be an object.']);
  const state = clone(input);
  for (const key of arrays) if (!Array.isArray(state[key])) state[key] = [];
  state.meta = state.meta && typeof state.meta === 'object' ? state.meta : {};
  state.uiByTheme = state.uiByTheme && typeof state.uiByTheme === 'object' && !Array.isArray(state.uiByTheme) ? state.uiByTheme : {};
  state.displaySettings = state.displaySettings && typeof state.displaySettings === 'object' ? state.displaySettings : {};

  state.version = PROJECT_DOCUMENT_VERSION;
  state.meta.id = string(state.meta.id);
  state.meta.name = string(state.meta.name, 'My Ideation Project').slice(0, 160);
  state.meta.createdAt = string(state.meta.createdAt, new Date().toISOString());
  state.meta.updatedAt = string(state.meta.updatedAt, state.meta.createdAt);
  state.displaySettings = {
    ideaTitleSize: Math.min(32, Math.max(12, Number(state.displaySettings.ideaTitleSize) || 18)),
    ideaDetailsSize: Math.min(24, Math.max(10, Number(state.displaySettings.ideaDetailsSize) || 14)),
    implementationTitleSize: Math.min(28, Math.max(10, Number(state.displaySettings.implementationTitleSize) || 14)),
    implementationDetailsSize: Math.min(22, Math.max(10, Number(state.displaySettings.implementationDetailsSize) || 13)),
  };

  state.themes = state.themes.map((item) => ({
    ...item,
    id: string(item?.id),
    name: string(item?.name, 'Untitled theme').slice(0, 160),
    parentId: string(item?.parentId) || null,
    hiddenInheritedImplementationIds: stringIds(item?.hiddenInheritedImplementationIds),
    hiddenInheritedConflictIds: stringIds(item?.hiddenInheritedConflictIds),
  }));
  state.ideas = state.ideas.map((item, index) => ({
    ...normalizeMarkdownItem(item, 'Untitled idea', index),
    groupIds: stringIds(item?.groupIds),
  }));
  state.implementations = state.implementations.map((item, index) => ({
    ...normalizeMarkdownItem(item, 'Untitled implementation', index),
    ideaIds: stringIds(item?.ideaIds),
    themeIds: stringIds(item?.themeIds),
    groupIds: stringIds(item?.groupIds),
    attachments: Array.isArray(item?.attachments) ? item.attachments : [],
  }));
  state.conflicts = state.conflicts.map((item) => {
    const normalized = normalizeMarkdownItem(item);
    return {
      ...normalized,
      name: string(item?.name, 'Untitled conflict').slice(0, 240),
      themeId: string(item?.themeId) || null,
      implementationIds: stringIds(item?.implementationIds),
      overridesConflictId: string(item?.overridesConflictId) || null,
    };
  });
  state.requirements = state.requirements.map((item) => {
    const normalized = normalizeMarkdownItem(item);
    return {
      ...normalized,
      fromImplementationId: string(item?.fromImplementationId),
      toImplementationId: string(item?.toImplementationId),
    };
  });
  state.savedViews = state.savedViews.map((item) => ({
    ...item,
    id: string(item?.id),
    name: string(item?.name, 'Untitled view').slice(0, 160),
    themeId: string(item?.themeId),
    lockedImplementationIds: stringIds(item?.lockedImplementationIds),
  }));
  state.uiByTheme = Object.fromEntries(Object.entries(state.uiByTheme).map(([themeId, view]) => [themeId, normalizeView(view)]));
  state.activeThemeId = string(state.activeThemeId);
  return state;
}

function duplicateIds(list) {
  const seen = new Set();
  const duplicates = new Set();
  for (const item of list) {
    if (!item.id) continue;
    if (seen.has(item.id)) duplicates.add(item.id);
    seen.add(item.id);
  }
  return [...duplicates];
}

export function validateProjectDocument(input, { maxBytes = MAX_PROJECT_DOCUMENT_BYTES } = {}) {
  const state = migrateProjectDocument(input);
  const issues = [];
  const bytes = new TextEncoder().encode(JSON.stringify(state)).byteLength;
  if (bytes > maxBytes) issues.push(`Project document exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB limit.`);
  if (!state.meta.id) issues.push('Project metadata is missing an id.');
  if (!state.themes.length) issues.push('At least one theme is required.');

  for (const key of ['themes', 'ideaGroups', 'implementationGroups', 'ideas', 'implementations', 'groupLinks', 'conflicts', 'requirements', 'savedViews']) {
    for (const duplicate of duplicateIds(state[key])) issues.push(`${key} contains duplicate id ${duplicate}.`);
    if (state[key].some((item) => !item.id)) issues.push(`${key} contains an item without an id.`);
  }

  const ids = (key) => new Set(state[key].map((item) => item.id));
  const themeIds = ids('themes');
  const ideaIds = ids('ideas');
  const implementationIds = ids('implementations');
  const ideaGroupIds = ids('ideaGroups');
  const implementationGroupIds = ids('implementationGroups');
  const conflictIds = ids('conflicts');
  if (!themeIds.has(state.activeThemeId)) issues.push('The active theme does not exist.');

  for (const theme of state.themes) {
    if (theme.parentId && !themeIds.has(theme.parentId)) issues.push(`Theme ${theme.id} has a missing parent.`);
    const seen = new Set([theme.id]);
    let parentId = theme.parentId;
    while (parentId) {
      if (seen.has(parentId)) {
        issues.push(`Theme ${theme.id} is part of a parent cycle.`);
        break;
      }
      seen.add(parentId);
      parentId = state.themes.find((item) => item.id === parentId)?.parentId || null;
    }
  }
  for (const idea of state.ideas) for (const groupId of idea.groupIds) if (!ideaGroupIds.has(groupId)) issues.push(`Idea ${idea.id} references missing group ${groupId}.`);
  for (const item of state.implementations) {
    for (const ideaId of item.ideaIds) if (!ideaIds.has(ideaId)) issues.push(`Implementation ${item.id} references missing idea ${ideaId}.`);
    for (const themeId of item.themeIds) if (!themeIds.has(themeId)) issues.push(`Implementation ${item.id} references missing theme ${themeId}.`);
    for (const groupId of item.groupIds) if (!implementationGroupIds.has(groupId)) issues.push(`Implementation ${item.id} references missing group ${groupId}.`);
  }
  for (const conflict of state.conflicts) {
    if (conflict.themeId && !themeIds.has(conflict.themeId)) issues.push(`Conflict ${conflict.id} references a missing theme.`);
    if (conflict.implementationIds.length < 2) issues.push(`Conflict ${conflict.id} must contain at least two implementations.`);
    for (const implementationId of conflict.implementationIds) if (!implementationIds.has(implementationId)) issues.push(`Conflict ${conflict.id} references missing implementation ${implementationId}.`);
    if (conflict.overridesConflictId && !conflictIds.has(conflict.overridesConflictId)) issues.push(`Conflict ${conflict.id} overrides a missing conflict.`);
  }
  for (const requirement of state.requirements) {
    if (!implementationIds.has(requirement.fromImplementationId) || !implementationIds.has(requirement.toImplementationId)) issues.push(`Requirement ${requirement.id} references a missing implementation.`);
    if (requirement.fromImplementationId === requirement.toImplementationId) issues.push(`Requirement ${requirement.id} cannot require itself.`);
  }
  for (const saved of state.savedViews) {
    if (!themeIds.has(saved.themeId)) issues.push(`Saved view ${saved.id} references a missing theme.`);
    for (const implementationId of saved.lockedImplementationIds) if (!implementationIds.has(implementationId)) issues.push(`Saved view ${saved.id} references a missing implementation.`);
  }
  if (issues.length) throw new ProjectValidationError(issues);
  return state;
}

const transientViewKeys = ['search', 'expandedIdeaIds', 'expandedImplementationIds', 'selectedImplementationIds'];

export function projectDocumentForPersistence(input) {
  const state = validateProjectDocument(input);
  for (const view of Object.values(state.uiByTheme || {})) {
    for (const key of transientViewKeys) delete view[key];
  }
  return state;
}

export function projectContentFingerprint(state) {
  const comparable = clone(state);
  for (const view of Object.values(comparable.uiByTheme || {})) {
    for (const key of transientViewKeys) delete view[key];
  }
  return JSON.stringify(comparable, (key, value) => key === 'updatedAt' ? undefined : value);
}
