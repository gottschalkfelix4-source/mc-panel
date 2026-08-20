'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const roots = ['index.js', 'src', 'public/js', 'scripts', 'test'];
const files = [];

function collect(entry) {
  const absolute = path.resolve(entry);
  if (!fs.existsSync(absolute)) return;
  const stat = fs.statSync(absolute);
  if (stat.isFile()) {
    if (absolute.endsWith('.js')) files.push(absolute);
    return;
  }
  for (const name of fs.readdirSync(absolute)) collect(path.join(absolute, name));
}

for (const root of roots) collect(root);
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax OK (${files.length} Dateien)`);
