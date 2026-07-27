import test from 'node:test';
import assert from 'node:assert/strict';
import { blockingConflicts, blendBackground, effectiveConflicts, effectiveImplementations, implementationConflictCount, lockWithRequirements, normalizeLocked, normalizeLockedWithRequirements, readableTextColor, requirementClosure, themeChain, unlockRequirementDependents } from '../public/core.mjs';

const state = {
  themes: [
    { id: 'root', parentId: null, hiddenInheritedImplementationIds: [], hiddenInheritedConflictIds: [] },
    { id: 'child', parentId: 'root', hiddenInheritedImplementationIds: ['hidden'], hiddenInheritedConflictIds: [] },
  ],
  implementations: [
    { id: 'a', themeIds: ['root'] },
    { id: 'b', themeIds: ['child'] },
    { id: 'hidden', themeIds: ['root'] },
  ],
  conflicts: [
    { id: 'c1', themeId: 'root', implementationIds: ['a', 'b', 'hidden'] },
  ],
};

test('theme inheritance follows child to root', () => {
  assert.deepEqual(themeChain(state.themes, 'child'), ['child', 'root']);
});

test('effective implementations inherit and can hide inherited entries', () => {
  assert.deepEqual(effectiveImplementations(state, 'child').map((item) => item.id), ['a', 'b']);
});

test('multiway conflict only blocks the completing member', () => {
  const conflicts = effectiveConflicts(state, 'child');
  assert.equal(blockingConflicts(conflicts, ['a'], 'b').length, 0);
  assert.equal(blockingConflicts(conflicts, ['a', 'b'], 'hidden').length, 1);
});

test('lock normalization drops only choices that complete conflicts', () => {
  const conflicts = effectiveConflicts(state, 'child');
  assert.deepEqual(normalizeLocked(conflicts, ['a', 'b', 'hidden']), ['a', 'b']);
});

test('directed requirements close through chains and cycles', () => {
  const requirements = [
    { fromImplementationId: 'a', toImplementationId: 'b' },
    { fromImplementationId: 'b', toImplementationId: 'c' },
    { fromImplementationId: 'c', toImplementationId: 'a' },
  ];
  assert.deepEqual(requirementClosure(requirements, ['a']).sort(), ['a', 'b', 'c']);
  assert.deepEqual(unlockRequirementDependents(requirements, ['a', 'b', 'c'], 'b'), []);
});

test('requirement chains are rejected when they complete a conflict or need an unavailable choice', () => {
  const requirements = [{ fromImplementationId: 'a', toImplementationId: 'b' }];
  const conflicts = [{ implementationIds: ['b', 'c'] }];
  const blocked = lockWithRequirements(conflicts, requirements, ['c'], 'a', ['a', 'b', 'c']);
  assert.equal(blocked.completedConflicts.length, 1);
  const unavailable = lockWithRequirements([], requirements, [], 'a', ['a']);
  assert.deepEqual(unavailable.missingIds, ['b']);
  assert.deepEqual(normalizeLockedWithRequirements([], requirements, ['a'], ['a']), []);
});

test('a child conflict override replaces its inherited base conflict', () => {
  const overrideState = structuredClone(state);
  overrideState.conflicts.push({ id: 'c2', themeId: 'child', implementationIds: ['a', 'b'], overridesConflictId: 'c1' });
  assert.deepEqual(effectiveConflicts(overrideState, 'child').map((item) => item.id), ['c2']);
});

test('a child theme can hide an inherited conflict', () => {
  const hiddenState = structuredClone(state);
  hiddenState.themes.find((theme) => theme.id === 'child').hiddenInheritedConflictIds = ['c1'];
  assert.deepEqual(effectiveConflicts(hiddenState, 'child'), []);
});

test('themeChain returns empty for an unknown theme', () => {
  assert.deepEqual(themeChain(state.themes, 'missing'), []);
});

test('themeChain tolerates a malformed parent cycle', () => {
  const cyclic = [
    { id: 'x', parentId: 'y' },
    { id: 'y', parentId: 'x' },
  ];
  assert.deepEqual(themeChain(cyclic, 'x'), ['x', 'y']);
});

test('blendBackground returns a default gradient when no colors are given', () => {
  assert.match(blendBackground([]), /^linear-gradient/);
  assert.equal(blendBackground([null, undefined]), blendBackground([]));
});

test('blendBackground returns the single color unchanged and stacks many', () => {
  assert.equal(blendBackground(['#aabbcc']), '#aabbcc');
  const multi = blendBackground(['#ff0000', '#00ff00', '#0000ff']);
  assert.ok(multi.startsWith('linear-gradient(135deg,'));
  assert.ok(multi.includes('#ff0000') && multi.includes('#0000ff'));
});

test('readableTextColor picks dark text by default and adapts to luminance', () => {
  assert.equal(readableTextColor([]), '#172033');
  assert.equal(readableTextColor(['#ffffff']), '#172033');
  assert.equal(readableTextColor(['#000000']), '#ffffff');
  assert.equal(readableTextColor(['#3b82f6']), '#ffffff');
});

test('readableTextColor averages across multiple group colors', () => {
  const lightOnDark = readableTextColor(['#111111', '#222222']);
  const darkOnLight = readableTextColor(['#eeeeee', '#dddddd']);
  assert.equal(lightOnDark, '#ffffff');
  assert.equal(darkOnLight, '#172033');
});

test('readableTextColor treats invalid hex as a bright fallback', () => {
  assert.equal(readableTextColor(['not-a-color']), '#172033');
});

test('implementationConflictCount counts every conflict touching a member', () => {
  const conflicts = [
    { id: 'c1', implementationIds: ['a', 'b'] },
    { id: 'c2', implementationIds: ['a', 'c'] },
    { id: 'c3', implementationIds: ['b', 'c'] },
  ];
  assert.equal(implementationConflictCount(conflicts, 'a'), 2);
  assert.equal(implementationConflictCount(conflicts, 'b'), 2);
  assert.equal(implementationConflictCount(conflicts, 'c'), 2);
  assert.equal(implementationConflictCount(conflicts, 'missing'), 0);
});
