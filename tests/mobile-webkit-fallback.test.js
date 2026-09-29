'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function runEarlyDetector(navigator) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const marker = 'iPadOS 上所有浏览器都使用 WebKit';
  const start = html.indexOf('<script>', html.indexOf(marker) - 400);
  const end = html.indexOf('</script>', start);
  assert.ok(start >= 0 && end > start, 'early mobile WebKit detector should exist');
  const attributes = {};
  const context = {
    navigator,
    document: { documentElement: { setAttribute: (name, value) => { attributes[name] = value; } } }
  };
  vm.runInNewContext(html.slice(start + 8, end), context);
  return attributes;
}

test('early detector marks ordinary and desktop-mode iPads before styles load', () => {
  assert.equal(runEarlyDetector({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0)', platform: 'iPad', maxTouchPoints: 5 })['data-mobile-webkit'], 'true');
  assert.equal(runEarlyDetector({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 })['data-mobile-webkit'], 'true');
});

test('early detector leaves desktop Edge on the full renderer', () => {
  assert.equal(runEarlyDetector({ userAgent: 'Mozilla/5.0 Edg/140.0', platform: 'Win32', maxTouchPoints: 0 })['data-mobile-webkit'], undefined);
});
