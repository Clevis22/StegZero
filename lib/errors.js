'use strict';

// Exit codes are documented in CLI.md and must stay stable.
const EXIT = Object.freeze({
  OK: 0,
  NO_RESULT: 1,
  USAGE: 2,
  IO: 3,
  PASSPHRASE: 4,
  INVALID_DATA: 5
});

class CliError extends Error {
  constructor(exitCode, code, message) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.code = code;
  }
}

module.exports = { CliError, EXIT };
