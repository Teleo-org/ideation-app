const root = document.querySelector('#shared-project');
const slug = decodeURIComponent(location.pathname.slice(1));
let project; let share; let localView;

function escapeHtml(value) { return String(value || '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character])); }
function byId(list, itemId) { return (list || []).find((item) => item.id === itemId); }
function ordered(items) { return [...items].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || String(a.title).localeCompare(String(b.title))); }
function unique(values) { return [...new Set(values)]; }

function detailsHtml(value) {
  const holder = document.createElement('div'); holder.innerHTML = value || '';
  holder.querySelectorAll('script, style, iframe, object, embed').forEach((node) => node.remove());
  holder.querySelectorAll('*').forEach((node) => [...node.attributes].forEach((attribute) => {
    if (attribute.name.startsWith('on') || (attribute.name === 'href' && /^javascript:/i.test(attribute.value))) node.removeAttribute(attribute.name);
  }));
  return holder.innerHTML;
}

function themeImplementations() {
  const themeId = project.activeThemeId; const themes = project.themes || [];
  const chain = new Set(); let current = byId(themes, themeId);
  while (current && !chain.has(current.id)) { chain.add(current.id); current = current.parentId ? byId(themes, current.parentId) : null; }
  const hidden = new Set(byId(themes, themeId)?.hiddenInheritedImplementationIds || []);
  return (project.implementations || []).filter((item) => item.themeIds?.some((id) => chain.has(id)) && (item.themeIds.includes(themeId) || !hidden.has(item.id))).map((item) => ({ ...item, directInTheme: item.themeIds.includes(themeId) }));
}

function initialView() {
  const saved = structuredClone(project.uiByTheme?.[project.activeThemeId] || {});
  const effectiveIds = themeImplementations().map((item) => item.id);
  saved.visibleImplementationIds = unique((saved.visibleImplementationIds?.length ? saved.visibleImplementationIds : effectiveIds).filter((id) => effectiveIds.includes(id)));
  saved.previousVisibleImplementationIds ||= []; saved.expandedIdeaIds ||= []; saved.expandedImplementationIds ||= [];
  saved.ideaGroupFilterIds ||= saved.ideaGroupFilter && saved.ideaGroupFilter !== 'all' ? [saved.ideaGroupFilter] : [];
  saved.showExcluded ??= true; saved.search ||= ''; saved.lockedImplementationIds ||= [];
  return saved;
}

function cardStyle(idea) {
  const colors = (idea.groupIds || []).map((id) => byId(project.ideaGroups, id)?.color).filter(Boolean);
  if (!colors.length) return '--idea-bg:linear-gradient(135deg, #f8fafc, #eef2f7);--idea-fg:#172033;';
  return `--idea-bg:${colors.length === 1 ? colors[0] : `linear-gradient(135deg, ${colors.join(', ')})`};--idea-fg:#172033;`;
}

function groupPicker() {
  const selected = new Set(localView.ideaGroupFilterIds);
  const label = !selected.size ? 'All groups' : selected.size === 1 && selected.has('__ungrouped__') ? 'Ungrouped' : `${selected.size} groups`;
  const row = (id, name) => `<div class="group-filter-row"><button data-view-action="group-only" data-id="${id}">${escapeHtml(name)}</button><button class="group-filter-toggle ${selected.has(id) ? 'active' : ''}" data-view-action="group-toggle" data-id="${id}" aria-label="Toggle ${escapeHtml(name)}">${selected.has(id) ? '✓' : '+'}</button></div>`;
  return `<label class="compact-field"><span>Idea groups</span><details id="shared-group-filter" class="group-filter"><summary>${label}</summary><div id="idea-group-filter-options">${row('all', 'All groups')}${row('__ungrouped__', 'Ungrouped')}${(project.ideaGroups || []).map((group) => row(group.id, group.name || 'Untitled group')).join('')}</div></details></label>`;
}

function render() {
  const theme = byId(project.themes, project.activeThemeId); const implementations = themeImplementations();
  const locked = new Set(localView.lockedImplementationIds); const visible = new Set(localView.visibleImplementationIds);
  const groups = new Set(localView.ideaGroupFilterIds); const search = localView.search.trim().toLowerCase();
  const conflictBlocked = (item) => (project.conflicts || []).some((conflict) => conflict.implementationIds?.includes(item.id) && conflict.implementationIds.every((id) => id === item.id || locked.has(id)));
  const ideas = ordered(project.ideas || []).filter((idea) => (!groups.size || (groups.has('__ungrouped__') && !(idea.groupIds || []).length) || (idea.groupIds || []).some((id) => groups.has(id))) && (!search || `${idea.title} ${idea.detailsHtml || ''}`.toLowerCase().includes(search) || implementations.some((item) => item.ideaIds?.includes(idea.id) && `${item.title} ${item.detailsHtml || ''}`.toLowerCase().includes(search))));
  document.title = `${project.meta?.name || 'Shared project'} · Ideation Workbench`;
  root.innerHTML = `<div class="app"><header class="topbar share-topbar"><div class="brand-inline"><div class="brand-mark small">IW</div><div><strong>${escapeHtml(project.meta?.name || 'Untitled project')}</strong><div class="tiny muted">Read-only ${share.mode === 'live' ? 'live view' : 'snapshot'}</div></div></div><div class="share-meta"><strong>${escapeHtml(theme?.name || 'Core')}</strong><div class="share-readonly">Theme</div></div></header><section class="filterbar share-filterbar"><label class="search-box"><span class="sr-only">Search</span><input id="shared-search" type="search" placeholder="Search ideas and implementations…" value="${escapeHtml(localView.search)}" /></label>${groupPicker()}<button class="button ghost compact" data-view-action="show-all">Show all</button><button class="button ghost compact" data-view-action="hide-all">Hide all</button><button class="button ghost compact" data-view-action="restore">Restore previous</button><label class="toggle-label" title="Shows implementations that would complete a conflict with the current locked view."><input id="shared-show-excluded" type="checkbox" ${localView.showExcluded ? 'checked' : ''} /> Show excluded</label></section><main class="board-wrap share-board-wrap"><div class="board" id="shared-board"></div></main></div>`;
  const board = document.querySelector('#shared-board');
  if (!ideas.length) { board.innerHTML = '<p class="muted">No ideas match this view.</p>'; return; }
  board.innerHTML = ideas.map((idea) => {
    const ideaGroups = (idea.groupIds || []).map((id) => byId(project.ideaGroups, id)).filter(Boolean);
    const linked = ordered(implementations.filter((item) => item.ideaIds?.includes(idea.id)));
    const shown = linked.filter((item) => visible.has(item.id) && (localView.showExcluded || !conflictBlocked(item)));
    const hidden = linked.filter((item) => !visible.has(item.id)); const expanded = localView.expandedIdeaIds.includes(idea.id);
    return `<section class="idea-card" style="${cardStyle(idea)}"><header class="idea-header"><h2 class="idea-title">${escapeHtml(idea.title || 'Untitled idea')}</h2><div class="idea-control-row"><div class="idea-group-dots">${ideaGroups.map((group) => `<span class="color-dot" title="${escapeHtml(group.name || 'Untitled group')}" style="background:${escapeHtml(group.color || '#d5dbe5')}"></span>`).join('')}</div><div class="idea-actions"><button class="icon-button" data-view-action="idea-details" data-id="${idea.id}" title="Toggle details">${expanded ? '▴' : '▾'}</button></div></div></header>${expanded && idea.detailsHtml ? `<div class="idea-details">${detailsHtml(idea.detailsHtml)}</div>` : ''}<div class="implementation-list">${shown.length ? shown.map((item) => { const detailOpen = localView.expandedImplementationIds.includes(item.id); return `<article class="impl-row share-implementation ${locked.has(item.id) ? 'locked' : ''}"><div class="impl-main"><strong class="impl-title-button">${escapeHtml(item.title || 'Untitled implementation')}</strong><div class="impl-subline">${!item.directInTheme ? '<span class="micro-badge">Inherited</span>' : ''}${locked.has(item.id) ? '<span class="micro-badge">Locked</span>' : ''}${conflictBlocked(item) ? '<span class="micro-badge warning">Conflict</span>' : ''}</div></div><div class="impl-actions"><button data-view-action="implementation-details" data-id="${item.id}" title="Toggle details">${detailOpen ? '▴' : '▾'}</button></div>${detailOpen && item.detailsHtml ? `<div class="impl-details">${detailsHtml(item.detailsHtml)}</div>` : ''}</article>`; }).join('') : `<div class="empty-impl">${linked.length ? 'All implementations are hidden or excluded.' : 'No implementations in this theme.'}</div>`}${hidden.length ? `<div class="hidden-strip">${hidden.map((item) => `<span class="hidden-chip">${escapeHtml(item.title)} <button data-view-action="show-one" data-id="${item.id}">show</button></span>`).join('')}</div>` : ''}</div></section>`;
  }).join('');
}

root.addEventListener('input', (event) => {
  if (event.target.id === 'shared-search') { localView.search = event.target.value; render(); }
  if (event.target.id === 'shared-show-excluded') { localView.showExcluded = event.target.checked; render(); }
});
root.addEventListener('click', (event) => {
  const button = event.target.closest('[data-view-action]'); if (!button) return;
  const action = button.dataset.viewAction; const id = button.dataset.id;
  if (action === 'show-all') { localView.previousVisibleImplementationIds = [...localView.visibleImplementationIds]; localView.visibleImplementationIds = themeImplementations().map((item) => item.id); }
  if (action === 'hide-all') { localView.previousVisibleImplementationIds = [...localView.visibleImplementationIds]; localView.visibleImplementationIds = []; }
  if (action === 'restore') { const previous = [...localView.previousVisibleImplementationIds]; localView.previousVisibleImplementationIds = [...localView.visibleImplementationIds]; localView.visibleImplementationIds = previous; }
  if (action === 'show-one') localView.visibleImplementationIds = unique([...localView.visibleImplementationIds, id]);
  if (action === 'idea-details') localView.expandedIdeaIds = localView.expandedIdeaIds.includes(id) ? localView.expandedIdeaIds.filter((item) => item !== id) : [...localView.expandedIdeaIds, id];
  if (action === 'implementation-details') localView.expandedImplementationIds = localView.expandedImplementationIds.includes(id) ? localView.expandedImplementationIds.filter((item) => item !== id) : [...localView.expandedImplementationIds, id];
  if (action === 'group-only') localView.ideaGroupFilterIds = id === 'all' ? [] : [id];
  if (action === 'group-toggle') localView.ideaGroupFilterIds = localView.ideaGroupFilterIds.includes(id) ? localView.ideaGroupFilterIds.filter((item) => item !== id) : [...localView.ideaGroupFilterIds, id];
  render(); if (action === 'group-toggle') document.querySelector('#shared-group-filter').open = true;
});

try {
  const response = await fetch(`/api/public-shares/${encodeURIComponent(slug)}`);
  if (!response.ok) throw new Error(response.status === 404 ? 'This shared project is unavailable.' : 'Could not load this shared project.');
  share = await response.json(); project = share.state; localView = initialView(); render();
} catch (error) { root.textContent = error.message; }
