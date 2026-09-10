'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../js/friends-polling-policy');

test('chat polling backs off after quiet periods', () => {
  assert.equal(policy.nextChatDelay(0), 3000);
  assert.equal(policy.nextChatDelay(29999), 3000);
  assert.equal(policy.nextChatDelay(30000), 10000);
  assert.equal(policy.nextChatDelay(119999), 10000);
  assert.equal(policy.nextChatDelay(120000), 30000);
});

test('message merge adds only unseen rows and preserves chronological order', () => {
  const existing = [{ id: 2, created_at: '2026-09-10T08:00:02Z', content: 'two' }];
  const result = policy.mergeMessages(existing, [
    { id: 2, created_at: '2026-09-10T08:00:02Z', content: 'two' },
    { id: 1, created_at: '2026-09-10T08:00:01Z', content: 'one' },
    { id: 3, created_at: '2026-09-10T08:00:03Z', content: 'three' }
  ]);
  assert.deepEqual(result.messages.map(row => row.id), [1, 2, 3]);
  assert.deepEqual(result.added.map(row => row.id), [1, 3]);
});

test('polling is disabled while offline, hidden, or outside the friends section', () => {
  assert.equal(policy.canPoll(), true);
  assert.equal(policy.canPoll({ online: false }), false);
  assert.equal(policy.canPoll({ visible: false }), false);
  assert.equal(policy.canPoll({ sectionActive: false }), false);
});
