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
  assert.equal(coordinator.pending.snapshot.value, 1);
  assert.ok(statuses.includes('conflict'));
});

test('analytics success metadata follows the snapshot that was acknowledged', async () => {
  const saved = [];
  const coordinator = new SaveCoordinator({
    journal: { async write() {}, async clear() {} },
    save: async (snapshot) => ({ state: snapshot }),
    onSaved(result, snapshot, metadata) { saved.push({ value: snapshot.value, events: metadata.analyticsEvents }); },
  });
  await coordinator.enqueue({ value: 1 }, { analyticsEvents: [{ event: 'idea_created' }] });
  assert.deepEqual(saved, [{ value: 1, events: [{ event: 'idea_created' }] }]);
});

test('a retry carries analytics success metadata forward to the latest snapshot', async () => {
  const saved = [];
  let calls = 0;
  let coordinator;
  coordinator = new SaveCoordinator({
    journal: { async write() {}, async clear() {} },
    async save(snapshot) {
      calls += 1;
      if (calls === 1) {
        await coordinator.enqueue({ value: 2 }, { analyticsEvents: [{ event: 'implementation_created' }] });
        throw new Error('offline');
      }
      return { state: snapshot };
    },
    onSaved(result, snapshot, metadata) { saved.push({ value: snapshot.value, events: metadata.analyticsEvents }); },
  });
  await coordinator.enqueue({ value: 1 }, { analyticsEvents: [{ event: 'idea_created' }] });
  await coordinator.drain();
  clearTimeout(coordinator.retryTimer);
  assert.deepEqual(saved, [{ value: 2, events: [{ event: 'idea_created' }, { event: 'implementation_created' }] }]);
});

