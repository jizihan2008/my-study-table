'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  isPathInside,
  normalizeExtensionId,
  parseExternalUrl,
  parsePublicWebUrl
} = require('../electron/security');

test('extension identifiers are accepted only when the complete value is safe', () => {
  assert.equal(normalizeExtensionId('study-tools_2'), 'study-tools_2');
  assert.equal(normalizeExtensionId('../study-tools'), '');
  assert.equal(normalizeExtensionId('study tools'), '');
});

test('path checks reject traversal and optionally accept the base itself', () => {
  const base = path.resolve('workspace');
  assert.equal(isPathInside(base, path.join(base, 'child', 'data.json')), true);
  assert.equal(isPathInside(base, path.join(base, '..', 'secret.txt')), false);
  assert.equal(isPathInside(base, base), false);
  assert.equal(isPathInside(base, base, { allowBase: true }), true);
});

test('external links reject renderer-executable and local file protocols', () => {
  assert.equal(parseExternalUrl('https://example.com').protocol, 'https:');
  assert.throws(() => parseExternalUrl('javascript:alert(1)'), /不允许/);
  assert.throws(() => parseExternalUrl('file:///C:/Windows/System32/drivers/etc/hosts'), /不允许/);
});

test('web reader rejects local and private network targets', () => {
  assert.equal(parsePublicWebUrl('https://example.com/page').hostname, 'example.com');
  assert.throws(() => parsePublicWebUrl('http://localhost:3000'), /本机或局域网/);
  assert.throws(() => parsePublicWebUrl('http://192.168.1.8'), /本机或局域网/);
  assert.throws(() => parsePublicWebUrl('http://[::1]/'), /本机或局域网/);
  assert.throws(() => parsePublicWebUrl('http://[fd00::1]/'), /本机或局域网/);
  assert.throws(() => parsePublicWebUrl('file:///tmp/a'), /不允许/);
});
