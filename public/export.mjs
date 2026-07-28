export function htmlToMarkdown(html) {
  if (!html) return '';
  let md = html;
  md = md.replace(/<pre>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');
  md = md.replace(/<h1>([\s\S]*?)<\/h1>/gi, (match, content) => {
    const trimmed = content.trim();
    return `\n# ${trimmed}\n`;
  });
  md = md.replace(/<h2>([\s\S]*?)<\/h2>/gi, (match, content) => {
    const trimmed = content.trim();
    return `\n## ${trimmed}\n`;
  });
  md = md.replace(/<h3>([\s\S]*?)<\/h3>/gi, (match, content) => {
    const trimmed = content.trim();
    return `\n### ${trimmed}\n`;
  });
  md = md.replace(/<h4>([\s\S]*?)<\/h4>/gi, (match, content) => {
    const trimmed = content.trim();
    return `\n#### ${trimmed}\n`;
  });
  md = md.replace(/<blockquote>([\s\S]*?)<\/blockquote>/gi, '\n> $1\n');
  md = md.replace(/<ul>([\s\S]*?)<\/ul>/gi, (_, inner) => inner.replace(/<li>([\s\S]*?)<\/li>/gi, '- $1\n'));
  md = md.replace(/<ol>([\s\S]*?)<\/ol>/gi, (_, inner) => {
    let num = 0;
    return inner.replace(/<li>([\s\S]*?)<\/li>/gi, (m, content) => `${++num}. ${content}\n`);
  });
  md = md.replace(/<p>([\s\S]*?)<\/p>/gi, '\n\n$1\n\n');
  md = md.replace(/<br\s*\/?>/gi, '\n');
  md = md.replace(/<strong>([\s\S]*?)<\/strong>/gi, '**$1**');
  md = md.replace(/<b>([\s\S]*?)<\/b>/gi, '**$1**');
  md = md.replace(/<em>([\s\S]*?)<\/em>/gi, '*$1*');
  md = md.replace(/<i>([\s\S]*?)<\/i>/gi, '*$1*');
  md = md.replace(/<s>([\s\S]*?)<\/s>/gi, '~~$1~~');
  md = md.replace(/<u>([\s\S]*?)<\/u>/gi, '$1');
  md = md.replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`');
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  md = md.replace(/<\/?div[^>]*>/gi, '');
  md = md.replace(/\n{3,}/g, '\n\n');
  md = md.trim();
  md = md.replace(/([^\n])\n{3,}/g, '$1\n\n');
  return md;
}

function nameOrFallback(item) {
  return item?.name || item?.title || 'Untitled';
}

function byId(list, id) {
  return list.find((item) => item.id === id);
}

function stripHtml(value = '') {
  return value.replace(/<[^>]*>/g, '');
}

export function generateExportMarkdown(state) {
  const lines = [];
  const h = (level, text) => lines.push(`${'#'.repeat(level)} ${text}`);
  const p = (text) => lines.push('', text, '');
  const blank = () => lines.push('');
  const hr = () => lines.push('', '---', '');

  h(1, state.meta.name);
  p(`*Created: ${state.meta.createdAt.split('T')[0]} | Updated: ${state.meta.updatedAt.split('T')[0]}*`);
  hr();

  lines.push('## Table of Contents', '');
  const sections = [];
  if (state.ideas.length) sections.push('- [Ideas](#ideas)');
  if (state.implementations.length) sections.push('- [Implementations](#implementations)');
  if (state.themes.length) sections.push('- [Themes](#themes)');
  if (state.ideaGroups.length) sections.push('- [Idea Groups](#idea-groups)');
  if (state.implementationGroups.length) sections.push('- [Implementation Groups](#implementation-groups)');
  if (state.groupLinks.length) sections.push('- [Group Connections](#group-connections)');
  if (state.conflicts.length) sections.push('- [Conflicts](#conflicts)');
  if (state.savedViews.length) sections.push('- [Saved Views](#saved-views)');
  lines.push(...sections, '');
  hr();

  if (state.ideas.length) {
    h(2, 'Ideas');
    blank();
    for (const idea of state.ideas) {
      const groups = (idea.groupIds || []).map((gid) => byId(state.ideaGroups, gid)).filter(Boolean);
      h(3, idea.title);
      if (groups.length) p(`**Groups:** ${groups.map((g) => g.name || 'Untitled').join(', ')}`);
      if (idea.detailsMarkdown) lines.push(idea.detailsMarkdown);
      else if (idea.detailsHtml) lines.push(htmlToMarkdown(idea.detailsHtml));
      blank();
    }
    hr();
  }

  if (state.implementations.length) {
    h(2, 'Implementations');
    blank();
    for (const impl of state.implementations) {
      const linkedIdeas = (impl.ideaIds || []).map((iid) => byId(state.ideas, iid)).filter(Boolean);
      const themes = (impl.themeIds || []).map((tid) => byId(state.themes, tid)).filter(Boolean);
      const groups = (impl.groupIds || []).map((gid) => byId(state.implementationGroups, gid)).filter(Boolean);
      const relConflicts = state.conflicts.filter((c) => c.implementationIds.includes(impl.id));
      h(3, impl.title);
      if (linkedIdeas.length) p(`**Linked Ideas:** ${linkedIdeas.map((i) => i.title).join(', ')}`);
      if (themes.length) p(`**Themes:** ${themes.map((t) => t.name).join(', ')}`);
      if (groups.length) p(`**Groups:** ${groups.map((g) => g.name || 'Untitled').join(', ')}`);
      if (relConflicts.length) p(`**Conflicts:** ${relConflicts.map((c) => c.name).join(', ')}`);
      if ((impl.attachments || []).length) p(`**Attachments:** ${impl.attachments.map((a) => `${a.name}${a.size ? ` (${(a.size / 1024).toFixed(0)} KB)` : ''}`).join(', ')}`);
      if (impl.detailsMarkdown) lines.push(impl.detailsMarkdown);
      else if (impl.detailsHtml) lines.push(htmlToMarkdown(impl.detailsHtml));
      blank();
    }
    hr();
  }

  if (state.themes.length) {
    h(2, 'Themes');
    blank();
    const children = new Map();
    for (const theme of state.themes) {
      const parent = theme.parentId || '__root__';
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(theme);
    }
    for (const list of children.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    const walk = (parentId, depth) => {
      for (const theme of children.get(parentId) || []) {
        lines.push(`${'  '.repeat(depth)}- **${theme.name}**${theme.parentId ? ` (parent: ${nameOrFallback(byId(state.themes, theme.parentId))})` : ' (root)'}`);
        walk(theme.id, depth + 1);
      }
    };
    walk('__root__', 0);
    blank();
    hr();
  }

  if (state.ideaGroups.length) {
    h(2, 'Idea Groups');
    blank();
    for (const group of state.ideaGroups) {
      lines.push(`- **${group.name || 'Untitled'}**${group.description ? ` — ${group.description}` : ''}${group.color ? ` \`${group.color}\`` : ''}`);
    }
    blank();
    hr();
  }

  if (state.implementationGroups.length) {
    h(2, 'Implementation Groups');
    blank();
    for (const group of state.implementationGroups) {
      lines.push(`- **${group.name || 'Untitled'}**${group.description ? ` — ${group.description}` : ''}${group.color ? ` \`${group.color}\`` : ''}`);
    }
    blank();
    hr();
  }

  if (state.groupLinks.length) {
    h(2, 'Group Connections');
    blank();
    for (const link of state.groupLinks) {
      const ig = byId(state.ideaGroups, link.ideaGroupId);
      const img = byId(state.implementationGroups, link.implementationGroupId);
      lines.push(`- **${ig?.name || 'Unknown'}** ↔ **${img?.name || 'Unknown'}**${link.description ? `: ${link.description}` : ''}`);
    }
    blank();
    hr();
  }

  if (state.conflicts.length) {
    h(2, 'Conflicts');
    blank();
    for (const conflict of state.conflicts) {
      const members = (conflict.implementationIds || []).map((iid) => byId(state.implementations, iid)).filter(Boolean);
      h(3, conflict.name);
      p(`**Scope:** ${conflict.themeId ? byId(state.themes, conflict.themeId)?.name || 'Unknown' : 'Global'}`);
      if (members.length) p(`**Members:** ${members.map((m) => m.title).join(', ')}`);
      if (conflict.overridesConflictId) {
        const overridden = byId(state.conflicts, conflict.overridesConflictId);
        if (overridden) p(`*Overrides: ${overridden.name}*`);
      }
      if (conflict.detailsMarkdown) lines.push(conflict.detailsMarkdown);
      else if (conflict.detailsHtml) lines.push(htmlToMarkdown(conflict.detailsHtml));
      blank();
    }
    hr();
  }

  if (state.savedViews.length) {
    h(2, 'Saved Views');
    blank();
    for (const view of state.savedViews) {
      const theme = byId(state.themes, view.themeId);
      lines.push(`- **${view.name}** — ${view.kind === 'rich' ? 'Rich view' : 'Simple selection'}${theme ? ` in ${theme.name}` : ''}, ${view.lockedImplementationIds.length} locked`);
    }
    blank();
  }

  return lines.join('\n');
}

export function stripBoldFromState(state) {
  let changed = false;
  const strip = (html) => {
    if (!html) return html;
    const cleaned = html.replace(/<\/?b[^>]*>/gi, '').replace(/<\/?strong[^>]*>/gi, '');
    if (cleaned !== html) changed = true;
    return cleaned;
  };
  for (const idea of state.ideas || []) {
    idea.detailsHtml = strip(idea.detailsHtml);
  }
  for (const impl of state.implementations || []) {
    impl.detailsHtml = strip(impl.detailsHtml);
  }
  for (const conflict of state.conflicts || []) {
    conflict.detailsHtml = strip(conflict.detailsHtml);
  }
  return changed;
}

export function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function markdownToHtml(md) {
  if (!md) return '';
  let html = md;
  html = html.replace(/```([\s\S]*?)```/g, '<pre>$1</pre>');
  html = html.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
  html = html.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
  const ulMatches = [...html.matchAll(/^(\s*)- (.+)$/gm)];
  for (const m of ulMatches) {
    const indent = m[1]?.length || 0;
    const content = m[2];
    const before = html.slice(0, m.index);
    const inUl = /<ul>/.test(before.split('').reverse().join(''));
    if (!inUl) {
      html = html.replace(m[0], '<ul>\n<li>' + content + '</li>');
    } else {
      html = html.replace(m[0], '<li>' + content + '</li>');
    }
  }
  html = html.replace(/^(\d+)\. (.+)$/gm, '<ol><li>$2</li></ol>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  html = '<p>' + html + '</p>';
  html = html.replace(/^<p>(<h[1-6]>)/gm, '$1');
  html = html.replace(/(<\/h[1-6]>)<\/p>$/gm, '$1');
  html = html.replace(/^<p>(<ul>)/gm, '$1');
  html = html.replace(/(<\/ul>)<\/p>$/gm, '$1');
  html = html.replace(/^<p>(<ol>)/gm, '$1');
  html = html.replace(/(<\/ol>)<\/p>$/gm, '$1');
  html = html.replace(/^<p>(<blockquote>)/gm, '$1');
  html = html.replace(/(<\/blockquote>)<\/p>$/gm, '$1');
  html = html.replace(/^<p>(<pre>)/gm, '$1');
  html = html.replace(/(<\/pre>)<\/p>$/gm, '$1');
  return html;
}

function parseSection(md, heading) {
  const lines = md.split('\n');
  const startPattern = new RegExp(`^## ${heading}\\s*`, '');
  const endPattern = /^## /;
  let inSection = false;
  let content = [];
  for (const line of lines) {
    if (startPattern.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && endPattern.test(line) && line !== `## ${heading}`) {
      break;
    }
    if (inSection) {
      content.push(line);
    }
  }
  return content.join('\n').trim();
}

function parseIdeaEntries(md) {
  const entries = [];
  const lines = md.split('\n');
  let currentTitle = null;
  let currentContent = [];
  for (const line of lines) {
    if (/^### /.test(line)) {
      if (currentTitle) entries.push({ title: currentTitle, content: currentContent.join('\n').trim() });
      currentTitle = line.replace(/^### /, '').trim();
      currentContent = [];
    } else if (currentTitle) {
      currentContent.push(line);
    }
  }
  if (currentTitle) entries.push({ title: currentTitle, content: currentContent.join('\n').trim() });
  return entries;
}

function parseImplEntries(md) {
  const entries = [];
  const lines = md.split('\n');
  let currentTitle = null;
  let currentTags = {};
  let currentContent = [];
  for (const line of lines) {
    if (/^### /.test(line)) {
      if (currentTitle) entries.push({ title: currentTitle, ...currentTags, content: currentContent.join('\n').trim() });
      currentTitle = line.replace(/^### /, '').trim();
      currentTags = {};
      currentContent = [];
    } else if (line.startsWith('**') && currentTitle) {
      const match = line.match(/^\*\*([^*]+)\*\*\s*:\s*(.+)$/);
      if (match) {
        const key = match[1].toLowerCase().replace(/\s+/g, '');
        const val = match[2].trim();
        currentTags[key.replace(/ /g, '')] = val;
      }
    } else if (line.startsWith('**') && currentTitle) {
      const match = line.match(/^\*\*([^*]+)\*\*\s*:\s*(.+)$/);
      if (match) {
        const key = match[1].toLowerCase();
        const stripped = key.replace(/\s+/g, '').replace(/s$/, '');
        currentTags[stripped] = match[2].trim();
      }
    } else if (currentTitle) {
      currentContent.push(line);
    }
  }
  if (currentTitle) entries.push({ title: currentTitle, ...currentTags, content: currentContent.join('\n').trim() });
  return entries;
}

function matchOrCreateGroup(list, name, color = null, description = null) {
  const existing = list.find((g) => g.name === name);
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  list.push({ id, name, color: color || '', description: description || '' });
  return id;
}

function matchOrCreateTheme(list, name, parentId = null) {
  if (!name) return null;
  const existing = list.find((t) => t.name === name);
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  list.push({ id, name, parentId, hiddenInheritedImplementationIds: [], hiddenInheritedConflictIds: [] });
  return id;
}

export function parseImportMarkdown(md, state) {
  const lines = md.split('\n');
  let projectName = state.meta.name;
  for (const line of lines) {
    if (line.startsWith('# ') && !line.startsWith('## ')) {
      projectName = line.slice(2).trim();
      break;
    }
  }
  const importedIds = { ideas: [], implementations: [], themes: [], ideaGroups: [], implementationGroups: [] };
  const ideasSection = parseSection(md, 'Ideas');
  if (ideasSection) {
    const ideaEntries = parseIdeaEntries(ideasSection);
    for (const entry of ideaEntries) {
      const title = entry.title;
      const groupMatch = entry.content.match(/^\*\*Groups\*\*\s*:\s*(.+)$/m);
      const groupNames = groupMatch ? groupMatch[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
      const groupIds = groupNames.map((g) => matchOrCreateGroup(state.ideaGroups, g));
      let details = entry.content;
      details = details.replace(/^\*\*Groups\*\*\s*:.+$/m, '').trim();
      const detailsMarkdown = details;
      const id = crypto.randomUUID();
      state.ideas.push({ id, title, detailsMarkdown, groupIds, sortOrder: state.ideas.length });
      importedIds.ideas.push(id);
    }
  }
  const implSection = parseSection(md, 'Implementations');
  if (implSection) {
    const implEntries = parseImplEntries(implSection);
    for (const entry of implEntries) {
      const title = entry.title;
      const ideaNames = (entry.linkedideas || '').split(',').map((s) => s.trim()).filter(Boolean);
      const themeNames = (entry.themes || '').split(',').map((s) => s.trim()).filter(Boolean);
      const groupIdNames = (entry.groups || '').split(',').map((s) => s.trim()).filter(Boolean);
      const ideaIds = ideaNames.map((n) => {
        const existing = state.ideas.find((i) => i.title === n);
        if (existing) return existing.id;
        const id = crypto.randomUUID();
        state.ideas.push({ id, title: n, detailsMarkdown: '', groupIds: [], sortOrder: state.ideas.length });
        importedIds.ideas.push(id);
        return id;
      });
      const themeIds = themeNames.map((n) => matchOrCreateTheme(state.themes, n));
      const groupIds = groupIdNames.map((g) => matchOrCreateGroup(state.implementationGroups, g));
      const id = crypto.randomUUID();
      state.implementations.push({ id, title, detailsMarkdown: entry.content || '', ideaIds, themeIds, groupIds, attachments: [], sortOrder: state.implementations.length });
      importedIds.implementations.push(id);
    }
  }
  state.meta.name = projectName;
  state.meta.updatedAt = new Date().toISOString();
  return importedIds;
}
