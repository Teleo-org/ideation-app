import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToMarkdown, stripBoldFromState, generateExportMarkdown, parseImportMarkdown } from '../public/export.mjs';

test('htmlToMarkdown converts bold tags', () => {
  assert.equal(htmlToMarkdown('<strong>bold</strong>'), '**bold**');
  assert.equal(htmlToMarkdown('<b>bold</b>'), '**bold**');
});

test('htmlToMarkdown converts italic tags', () => {
  assert.equal(htmlToMarkdown('<em>italic</em>'), '*italic*');
  assert.equal(htmlToMarkdown('<i>italic</i>'), '*italic*');
});

test('htmlToMarkdown converts strikethrough tags', () => {
  assert.equal(htmlToMarkdown('<s>strikethrough</s>'), '~~strikethrough~~');
});

test('htmlToMarkdown removes underline tags but keeps content', () => {
  assert.equal(htmlToMarkdown('<u>underlined</u>'), 'underlined');
});

test('htmlToMarkdown converts links to markdown format', () => {
  assert.equal(htmlToMarkdown('<a href="https://example.com">link</a>'), '[link](https://example.com)');
});

test('htmlToMarkdown converts unordered lists', () => {
  const ul = htmlToMarkdown('<ul><li>item 1</li><li>item 2</li></ul>');
  assert.ok(ul.includes('- item 1'));
  assert.ok(ul.includes('- item 2'));
});

test('htmlToMarkdown converts ordered lists', () => {
  const ol = htmlToMarkdown('<ol><li>first</li><li>second</li></ol>');
  assert.ok(ol.includes('1. first'));
  assert.ok(ol.includes('2. second'));
});

test('htmlToMarkdown converts headings', () => {
  assert.equal(htmlToMarkdown('<h1>Title</h1>'), '# Title');
  assert.equal(htmlToMarkdown('<h2>Subtitle</h2>'), '## Subtitle');
  assert.equal(htmlToMarkdown('<h3>Section</h3>'), '### Section');
  assert.equal(htmlToMarkdown('<h4>Detail</h4>'), '#### Detail');
});

test('htmlToMarkdown converts blockquotes', () => {
  const result = htmlToMarkdown('<blockquote>quoted text</blockquote>');
  assert.ok(result.includes('> quoted text'));
});

test('htmlToMarkdown converts code', () => {
  assert.equal(htmlToMarkdown('<code>code</code>'), '`code`');
});

test('htmlToMarkdown converts preformatted blocks', () => {
  const result = htmlToMarkdown('<pre>pre\ntext</pre>');
  assert.ok(result.includes('```'));
  assert.ok(result.includes('pre'));
  assert.ok(result.includes('text'));
});

test('htmlToMarkdown converts paragraphs', () => {
  const result = htmlToMarkdown('<p>First paragraph</p><p>Second paragraph</p>');
  assert.ok(result.includes('First paragraph'));
  assert.ok(result.includes('Second paragraph'));
});

test('htmlToMarkdown converts line breaks', () => {
  assert.equal(htmlToMarkdown('line1<br>line2'), 'line1\nline2');
  assert.equal(htmlToMarkdown('line1<br/>line2'), 'line1\nline2');
});

test('htmlToMarkdown strips div tags and cleans whitespace', () => {
  const result = htmlToMarkdown('<div>text</div>');
  assert.equal(result, 'text');
  const multiNewline = htmlToMarkdown('<p>a</p><p>b</p><p>c</p>');
  assert.ok(!multiNewline.includes('a\n\n\n'));
});

test('htmlToMarkdown handles combined formatting', () => {
  const html = '<p><strong>Bold</strong> and <em>italic</em></p><ul><li><a href="url">link</a></li></ul>';
  const result = htmlToMarkdown(html);
  assert.ok(result.includes('**Bold**'));
  assert.ok(result.includes('*italic*'));
  assert.ok(result.includes('[link](url)'));
});

test('htmlToMarkdown handles empty and null input', () => {
  assert.equal(htmlToMarkdown(''), '');
  assert.equal(htmlToMarkdown(null), '');
  assert.equal(htmlToMarkdown(undefined), '');
});

test('stripBoldFromState removes bold tags from all content fields', () => {
  const state = {
    ideas: [{ id: 'i1', title: 'Test', detailsHtml: '<strong>bold</strong> text' }],
    implementations: [{ id: 'impl1', title: 'Impl', ideaIds: [], themeIds: [], groupIds: [], detailsHtml: '<b>bold impl</b>' }],
    conflicts: [{ id: 'c1', name: 'Conflict', implementationIds: [] }],
  };
  const changed = stripBoldFromState(state);
  assert.equal(changed, true);
  assert.equal(state.ideas[0].detailsHtml, 'bold text');
  assert.equal(state.implementations[0].detailsHtml, 'bold impl');
  assert.equal(state.conflicts[0].detailsHtml, undefined);
});

test('stripBoldFromState returns false when no changes needed', () => {
  const state = {
    ideas: [{ id: 'i1', title: 'Test', detailsHtml: 'no bold' }],
    implementations: [],
    conflicts: [],
  };
  const changed = stripBoldFromState(state);
  assert.equal(changed, false);
});

test('generateExportMarkdown creates valid markdown structure', () => {
  const state = {
    meta: { name: 'Test Project', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' },
    ideas: [{ id: 'i1', title: 'My Idea', detailsHtml: 'Idea details', groupIds: [] }],
    implementations: [{ id: 'impl1', title: 'My Impl', detailsHtml: 'Impl details', ideaIds: ['i1'], themeIds: [], groupIds: [], attachments: [], sortOrder: 0 }],
    themes: [{ id: 't1', name: 'Core', parentId: null, hiddenInheritedImplementationIds: [], hiddenInheritedConflictIds: [] }],
    ideaGroups: [],
    implementationGroups: [],
    groupLinks: [],
    conflicts: [],
    savedViews: [],
  };
  const md = generateExportMarkdown(state);
  assert.ok(md.startsWith('# Test Project'));
  assert.ok(md.includes('## Table of Contents'));
  assert.ok(md.includes('## Ideas'));
  assert.ok(md.includes('## Implementations'));
  assert.ok(md.includes('## Themes'));
  assert.ok(md.includes('My Idea'));
  assert.ok(md.includes('My Impl'));
});

test('generateExportMarkdown handles empty project gracefully', () => {
  const state = {
    meta: { name: 'Empty Project', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    ideas: [],
    implementations: [],
    themes: [],
    ideaGroups: [],
    implementationGroups: [],
    groupLinks: [],
    conflicts: [],
    savedViews: [],
  };
  const md = generateExportMarkdown(state);
  assert.ok(md.startsWith('# Empty Project'));
  assert.ok(!md.includes('## Ideas'));
  assert.ok(!md.includes('## Implementations'));
});

test('generateExportMarkdown renders saved views correctly', () => {
  const state = {
    meta: { name: 'Test', createdAt: '2026-01-01', updatedAt: '2026-01-02' },
    ideas: [],
    implementations: [],
    themes: [],
    ideaGroups: [],
    implementationGroups: [],
    groupLinks: [],
    conflicts: [],
    savedViews: [
      { id: 'v1', name: 'My View', kind: 'rich', themeId: null, lockedImplementationIds: ['a', 'b'] },
      { id: 'v2', name: 'Simple View', kind: 'simple', themeId: null, lockedImplementationIds: [] },
    ],
  };
  const md = generateExportMarkdown(state);
  assert.ok(md.includes('## Saved Views'));
  assert.ok(md.includes('My View'));
  assert.ok(md.includes('Simple View'));
  assert.ok(md.includes('2 locked'));
});

test('generateExportMarkdown renders conflicts with members', () => {
  const state = {
    meta: { name: 'Test', createdAt: '2026-01-01', updatedAt: '2026-01-02' },
    ideas: [],
    implementations: [{ id: 'impl1', title: 'Impl A', ideaIds: [], themeIds: [], groupIds: [], sortOrder: 0 }],
    themes: [],
    ideaGroups: [],
    implementationGroups: [],
    groupLinks: [],
    conflicts: [{ id: 'c1', name: 'My Conflict', implementationIds: ['impl1'], themeId: null, detailsHtml: 'Conflict explanation', overridesConflictId: null }],
    savedViews: [],
  };
  const md = generateExportMarkdown(state);
  assert.ok(md.includes('## Conflicts'));
  assert.ok(md.includes('### My Conflict'));
  assert.ok(md.includes('Impl A'));
});

test('parseImportMarkdown creates ideas from markdown', () => {
  const state = {
    meta: { name: 'Test', createdAt: '2026-01-01', updatedAt: '2026-01-02' },
    ideas: [],
    implementations: [],
    themes: [{ id: 't1', name: 'Core', parentId: null, hiddenInheritedImplementationIds: [], hiddenInheritedConflictIds: [] }],
    ideaGroups: [],
    implementationGroups: [],
    groupLinks: [],
    conflicts: [],
    savedViews: [],
  };
  const md = '# Imported\n\n## Ideas\n\n### New Idea\n\nSome details';
  parseImportMarkdown(md, state);
  assert.equal(state.ideas.length, 1);
  assert.equal(state.ideas[0].title, 'New Idea');
  assert.ok(state.ideas[0].detailsHtml.includes('Some details'));
});

test('parseImportMarkdown creates implementations with linked ideas', () => {
  const state = {
    meta: { name: 'Test', createdAt: '2026-01-01', updatedAt: '2026-01-02' },
    ideas: [],
    implementations: [],
    themes: [{ id: 't1', name: 'Core', parentId: null, hiddenInheritedImplementationIds: [], hiddenInheritedConflictIds: [] }],
    ideaGroups: [],
    implementationGroups: [],
    groupLinks: [],
    conflicts: [],
    savedViews: [],
  };
  const md = '# Imported\n\n## Ideas\n\n### First Idea\n\n## Implementations\n\n### My Implementation\n\n**Linked Ideas:** First Idea\n\nDetails';
  parseImportMarkdown(md, state);
  assert.equal(state.ideas.length, 1);
  assert.equal(state.implementations.length, 1);
  assert.equal(state.implementations[0].title, 'My Implementation');
});