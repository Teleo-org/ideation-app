const root = document.querySelector('#shared-project');
const slug = decodeURIComponent(location.pathname.slice(1));

function text(value) { return String(value || ''); }
function details(value) { const holder = document.createElement('div'); holder.innerHTML = value || ''; return holder.textContent || ''; }

function render(state, share) {
  document.title = `${text(state.meta?.name) || 'Shared project'} · Ideation Workbench`;
  const ideas = state.ideas || []; const implementations = state.implementations || [];
  root.replaceChildren();
  const header = document.createElement('header');
  const title = document.createElement('h1'); title.textContent = text(state.meta?.name) || 'Untitled project';
  const meta = document.createElement('p'); meta.className = 'meta'; meta.textContent = share.mode === 'live' ? 'Read-only live view' : 'Read-only snapshot';
  header.append(title, meta); root.append(header);
  const list = document.createElement('section'); list.className = 'ideas';
  if (!ideas.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'This project has no ideas yet.'; list.append(empty); }
  for (const idea of ideas) {
    const card = document.createElement('article'); const heading = document.createElement('h2'); heading.textContent = text(idea.title) || 'Untitled idea'; card.append(heading);
    if (idea.detailsHtml) { const copy = document.createElement('p'); copy.className = 'details'; copy.textContent = details(idea.detailsHtml); card.append(copy); }
    const linked = implementations.filter((item) => (item.ideaIds || []).includes(idea.id));
    if (linked.length) {
      const impls = document.createElement('div'); impls.className = 'implementations';
      for (const implementation of linked) { const row = document.createElement('div'); row.className = 'implementation'; const name = document.createElement('strong'); name.textContent = text(implementation.title) || 'Untitled implementation'; row.append(name); if (implementation.detailsHtml) { const copy = document.createElement('span'); copy.className = 'details'; copy.textContent = details(implementation.detailsHtml); row.append(copy); } impls.append(row); }
      card.append(impls);
    }
    list.append(card);
  }
  root.append(list);
}

try {
  const response = await fetch(`/api/public-shares/${encodeURIComponent(slug)}`);
  if (!response.ok) throw new Error(response.status === 404 ? 'This shared project is unavailable.' : 'Could not load this shared project.');
  const payload = await response.json();
  render(payload.state, payload);
} catch (error) { root.textContent = error.message; }
