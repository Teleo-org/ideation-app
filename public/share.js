const root = document.querySelector('#shared-project');
const slug = decodeURIComponent(location.pathname.slice(1));

function escapeHtml(value) { return String(value || '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character])); }
function byId(list, itemId) { return (list || []).find((item) => item.id === itemId); }
function ordered(items) { return [...items].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || String(a.title).localeCompare(String(b.title))); }

function detailsHtml(value) {
  const holder = document.createElement('div');
  holder.innerHTML = value || '';
  holder.querySelectorAll('script, style, iframe, object, embed').forEach((node) => node.remove());
  holder.querySelectorAll('*').forEach((node) => [...node.attributes].forEach((attribute) => {
    if (attribute.name.startsWith('on') || (attribute.name === 'href' && /^javascript:/i.test(attribute.value))) node.removeAttribute(attribute.name);
  }));
  return holder.innerHTML;
}

function themeImplementations(state) {
  const themeId = state.activeThemeId;
  const themes = state.themes || [];
  const chain = new Set(); let current = byId(themes, themeId);
  while (current && !chain.has(current.id)) { chain.add(current.id); current = current.parentId ? byId(themes, current.parentId) : null; }
  const hidden = new Set(byId(themes, themeId)?.hiddenInheritedImplementationIds || []);
  return (state.implementations || []).filter((item) => item.themeIds?.some((id) => chain.has(id)) && (item.themeIds.includes(themeId) || !hidden.has(item.id))).map((item) => ({ ...item, directInTheme: item.themeIds.includes(themeId) }));
}

function cardStyle(state, idea) {
  const colors = (idea.groupIds || []).map((id) => byId(state.ideaGroups, id)?.color).filter(Boolean);
  if (!colors.length) return '--idea-bg:linear-gradient(135deg, #f8fafc, #eef2f7);--idea-fg:#172033;';
  return `--idea-bg:${colors.length === 1 ? colors[0] : `linear-gradient(135deg, ${colors.join(', ')})`};--idea-fg:${colors[0] === '#000000' ? '#fff' : '#172033'};`;
}

function render(state, share) {
  const theme = byId(state.themes, state.activeThemeId);
  const view = state.uiByTheme?.[state.activeThemeId] || {};
  const visible = new Set(view.visibleImplementationIds || []);
  const useVisibility = Array.isArray(view.visibleImplementationIds) && view.knownImplementationIds?.length;
  const implementations = themeImplementations(state);
  const locked = new Set(view.lockedImplementationIds || []);
  document.title = `${state.meta?.name || 'Shared project'} · Ideation Workbench`;
  root.innerHTML = `<div class="app"><header class="topbar share-topbar"><div class="brand-inline"><div class="brand-mark small">IW</div><div><strong>${escapeHtml(state.meta?.name || 'Untitled project')}</strong><div class="tiny muted">Read-only ${share.mode === 'live' ? 'live view' : 'snapshot'}</div></div></div><div class="share-meta"><strong>${escapeHtml(theme?.name || 'Core')}</strong><div class="share-readonly">Theme</div></div></header><main class="board-wrap share-board-wrap"><div class="board" id="shared-board"></div></main></div>`;
  const board = document.querySelector('#shared-board');
  const ideas = ordered(state.ideas || []);
  if (!ideas.length) { board.innerHTML = '<p class="muted">This project has no ideas yet.</p>'; return; }
  board.innerHTML = ideas.map((idea) => {
    const groups = (idea.groupIds || []).map((id) => byId(state.ideaGroups, id)).filter(Boolean);
    const linked = ordered(implementations.filter((item) => item.ideaIds?.includes(idea.id) && (!useVisibility || visible.has(item.id))));
    return `<section class="idea-card" style="${cardStyle(state, idea)}"><header class="idea-header"><h2 class="idea-title">${escapeHtml(idea.title || 'Untitled idea')}</h2><div class="idea-group-dots">${groups.map((group) => `<span class="color-dot" title="${escapeHtml(group.name || 'Untitled group')}" style="background:${escapeHtml(group.color || '#d5dbe5')}"></span>`).join('')}</div></header>${idea.detailsHtml ? `<div class="idea-details">${detailsHtml(idea.detailsHtml)}</div>` : ''}<div class="implementation-list">${linked.length ? linked.map((implementation) => `<article class="impl-row share-implementation ${locked.has(implementation.id) ? 'locked' : ''}"><div class="impl-main"><strong class="impl-title-button">${escapeHtml(implementation.title || 'Untitled implementation')}</strong><div class="impl-subline">${!implementation.directInTheme ? '<span class="micro-badge">Inherited</span>' : ''}${locked.has(implementation.id) ? '<span class="micro-badge">Locked</span>' : ''}</div></div>${implementation.detailsHtml ? `<div class="impl-details">${detailsHtml(implementation.detailsHtml)}</div>` : ''}</article>`).join('') : '<p class="empty-impl">No implementations in this theme.</p>'}</div></section>`;
  }).join('');
}

try {
  const response = await fetch(`/api/public-shares/${encodeURIComponent(slug)}`);
  if (!response.ok) throw new Error(response.status === 404 ? 'This shared project is unavailable.' : 'Could not load this shared project.');
  const payload = await response.json();
  render(payload.state, payload);
} catch (error) { root.textContent = error.message; }
