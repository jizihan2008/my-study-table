'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeBackupData } = require('../electron/backup-policy');

test('backup policy excludes secrets by default', () => {
  const output = sanitizeBackupData({
    study_todos_v2: '[{"id":1}]',
    study_api_keys: '[{"key":"secret"}]',
    study_mail_accounts: '[{"pass":"secret"}]'
  });
  assert.deepEqual(output, { study_todos_v2: '[{"id":1}]' });
});

test('backup policy can include secrets only after an explicit opt-in', () => {
  const source = { study_api_keys: '[{"key":"secret"}]' };
  assert.deepEqual(sanitizeBackupData(source, { includeSecrets: true }), source);
});
