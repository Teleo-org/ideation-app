import test from 'node:test';
import assert from 'node:assert/strict';
import { ideaOrder, implementationOrder, implementationOrderForIdea } from '../public/reorder.mjs';

test('ideaOrder assigns the order represented by the board', () => {
  const ideas = [{ id: 'a', sortOrder: 0 }, { id: 'b', sortOrder: 1 }, { id: 'c', sortOrder: 2 }];
  ideaOrder(ideas, ['c', 'a', 'b']);
  assert.deepEqual(ideas.map((idea) => idea.sortOrder), [1, 2, 0]);
});

test('implementationOrder keeps a separate order for each linked idea', () => {
  const implementations = [{ id: 'one', sortOrder: 0 }, { id: 'two', sortOrder: 1 }];
  implementationOrder(implementations, 'idea-a', ['two', 'one']);
  implementationOrder(implementations, 'idea-b', ['one', 'two']);
  assert.equal(implementationOrderForIdea(implementations[0], 'idea-a'), 1);
  assert.equal(implementationOrderForIdea(implementations[1], 'idea-a'), 0);
  assert.equal(implementationOrderForIdea(implementations[0], 'idea-b'), 0);
  assert.equal(implementationOrderForIdea(implementations[1], 'idea-b'), 1);
});
