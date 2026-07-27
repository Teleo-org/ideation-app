import test from 'node:test';
import assert from 'node:assert/strict';
import { allPairs, fuzzyMatches, requirementEdges, validRequirementChains } from '../public/relationships.mjs';

test('relationship picker fuzzy matching preserves ordered characters', () => {
  assert.equal(fuzzyMatches('Authentication service', 'ats'), true);
  assert.equal(fuzzyMatches('Authentication service', 'tsa'), false);
  assert.equal(fuzzyMatches('Authentication service', ''), true);
});

test('allPairs creates every pair exactly once', () => {
  assert.deepEqual(allPairs(['a', 'b', 'c']), [['a', 'b'], ['a', 'c'], ['b', 'c']]);
  assert.deepEqual(allPairs(['a']), []);
});

test('requirement builder creates a deduplicated many-to-many graph and rejects incomplete chains', () => {
  const chains = [{ from: ['a', 'b'], to: ['c'] }, { from: ['a'], to: ['c', 'd'] }, { from: [], to: ['e'] }];
  assert.equal(validRequirementChains(chains).length, 2);
  assert.deepEqual(requirementEdges(validRequirementChains(chains)), [
    { fromImplementationId: 'a', toImplementationId: 'c' },
    { fromImplementationId: 'b', toImplementationId: 'c' },
    { fromImplementationId: 'a', toImplementationId: 'd' },
  ]);
});

test('requirement builder supports a four-side directional chain and ignores self requirements', () => {
  const chains = [
    { from: ['a', 'b'], to: ['c'] },
    { from: ['c'], to: ['d'] },
    { from: ['d'], to: ['e'] },
    { from: ['same'], to: ['same'] },
  ];
  assert.deepEqual(requirementEdges(validRequirementChains(chains)), [
    { fromImplementationId: 'a', toImplementationId: 'c' },
    { fromImplementationId: 'b', toImplementationId: 'c' },
    { fromImplementationId: 'c', toImplementationId: 'd' },
    { fromImplementationId: 'd', toImplementationId: 'e' },
  ]);
});
