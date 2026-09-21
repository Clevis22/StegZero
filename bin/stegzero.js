#!/usr/bin/env node
'use strict';

const { run } = require('../lib/cli.js');

// Pipelines such as `stegzero inspect file | head` must not crash on EPIPE.
process.stdout.on('error', error => {
  if (error && error.code === 'EPIPE') process.exit(0);
  throw error;
});

run(process.argv).then(code => {
  process.exitCode = code;
}).catch(error => {
  process.stderr.write((error && error.stack ? error.stack : String(error)) + '\n');
  process.exitCode = 1;
});
