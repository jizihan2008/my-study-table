'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const sourceDirs = ['electron', 'js', 'lib', 'scripts', 'tests'];
const files = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(fullPath);
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(fullPath);
  }
}

for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.js')) files.push(path.join(root, entry.name));
}
for (const dir of sourceDirs) walk(path.join(root, dir));

const failures = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) failures.push({ file: path.relative(root, file), error: result.stderr.trim() });
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure.file + '\n' + failure.error);
  process.exitCode = 1;
} else {
  console.log('Syntax check passed for ' + files.length + ' JavaScript files.');
}
