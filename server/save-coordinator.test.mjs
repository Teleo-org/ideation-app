import test from 'node:test';
import assert from 'node:assert/strict';
import { SaveCoordinator } from '../public/save-coordinator.mjs';

test('overlapping edits are serialized and every latest edit is acknowledged', async () => {
  const resolvers = [];
  const calls = [];
  const saved = [];
  const journal = { async write() {}, async clear() {} };
  const coordinator = new SaveCoordinator({
    journal,
    save(snapshot) {
      calls.push(snapshot.value);
      return new Promise((resolve) => resolvers.push(() => resolve({ state: snapshot, revision: calls.length })));
    },
    onSaved(result) { saved.push(result.state.value); },
  });
  const first = coordinator.enqueue({ value: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  coordinator.enqueue({ value: 2 });
  coordinator.enqueue({ value: 3 });
  assert.deepEqual(calls, [1]);
  resolvers.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [1, 3]);
  resolvers.shift()();
  await first;
  assert.deepEqual(saved, [1, 3]);
});

test('a revision conflict preserves the pending snapshot', async () => {
  const statuses = [];
  const error = Object.assign(new Error('conflict'), { status: 409 });
  const coordinator = new SaveCoordinator({ journal: { async write() {} }, save: async () => { throw error; }, onStatus: (status) => statuses.push(status) });
  await coordinator.enqueue({ value: 1 });
  assert.equal(coordinator.pending.value, 1);
  assert.ok(statuses.includes('conflict'));
});

