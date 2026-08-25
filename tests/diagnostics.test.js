'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeDiagnostic } = require('../electron/diagnostics');

test('diagnostic logs redact common credential formats', () => {
  const value = sanitizeDiagnostic('password=hunter2 api_key=secret-value sk-abcdefghijklmnopqrstuvwxyz');
  assert.equal(value.includes('hunter2'), false);
  assert.equal(value.includes('secret-value'), false);
  assert.equal(value.includes('sk-abcdefghijklmnopqrstuvwxyz'), false);
});
