'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('two isolated clients preserve data across the multi-device scenarios', () => {
  const probe = path.join(__dirname, 'probe', 'multidevice-sync.js');
  const result = spawnSync(process.execPath, [probe], { encoding: 'utf8' });
  assert.equal(result.status, 0, (result.stdout || '') + (result.stderr || ''));
  assert.equal((result.stdout.match(/^PASS /gm) || []).length, 16);
});
