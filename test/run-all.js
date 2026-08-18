#!/usr/bin/env node
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

const tests = ['parser.test.js', 'sources-claude-code.test.js', 'api.test.js', 'initial-input.test.js', 'cc-workflow.test.js'];
let failures = 0;
for (const t of tests) {
  console.log(`\n=== ${t} ===`);
  const r = spawnSync(process.execPath, [path.join(__dirname, t)], { stdio: 'inherit' });
  if (r.status !== 0) failures++;
}
process.exit(failures ? 1 : 0);
