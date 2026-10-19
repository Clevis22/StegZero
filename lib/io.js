'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { CliError, EXIT } = require('./errors.js');

const CARRIER_FREE_MESSAGE = 'This file appears to be binary or lacks a supported UTF-16 byte-order mark.';

// Mirrors the website's BOM-aware decoder so the CLI reads the same files.
// The website rejects any early NUL byte as a likely binary upload; the CLI is a
// pipeline tool where isolated control codes (for example U+0000) are valid
// findings, so it only rejects input that is predominantly NUL bytes.
function looksBinary(sample) {
  if (!sample.length) return false;
  let nul = 0;
  for (const value of sample) if (value === 0) nul++;
  return nul > 0 && nul / sample.length > 0.5;
}

function decodeBuffer(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let encoding = 'utf-8';
  let offset = 0;
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) offset = 3;
  else if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) { encoding = 'utf-16le'; offset = 2; }
  else if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) { encoding = 'utf-16be'; offset = 2; }
  const sample = bytes.subarray(offset, Math.min(bytes.length, offset + 4096));
  if (encoding === 'utf-8' && looksBinary(sample)) {
    throw new CliError(EXIT.IO, 'EIO', CARRIER_FREE_MESSAGE);
  }
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(offset));
  } catch (_) {
    throw new CliError(EXIT.IO, 'EIO', 'The file is not valid UTF-8, UTF-16LE, or UTF-16BE text.');
  }
}

async function readTextFile(filePath) {
  let buffer;
  try {
    buffer = await fs.readFile(filePath);
  } catch (error) {
    throw new CliError(EXIT.IO, 'EIO', `Cannot read ${filePath}: ${error.message}`);
  }
  return decodeBuffer(buffer);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return decodeBuffer(Buffer.concat(chunks));
}

function stripOneLineEnding(value) {
  return value.endsWith('\r\n') ? value.slice(0, -2) : value.endsWith('\n') ? value.slice(0, -1) : value;
}

async function readSecretFile(filePath) {
  return stripOneLineEnding(await readTextFile(filePath));
}

async function fileExists(filePath) {
  try { await fs.access(filePath); return true; } catch (_) { return false; }
}

async function assertWritable(filePath, force) {
  if (!force && await fileExists(filePath)) {
    throw new CliError(EXIT.USAGE, 'EOVERWRITE', `Refusing to overwrite existing file ${filePath}. Use --force to replace it.`);
  }
}

async function writeOutput(text, outputPath, options = {}) {
  if (!outputPath) {
    process.stdout.write(text);
    return;
  }
  await assertWritable(outputPath, options.force);
  try {
    await fs.writeFile(outputPath, text, 'utf8');
  } catch (error) {
    throw new CliError(EXIT.IO, 'EIO', `Cannot write ${outputPath}: ${error.message}`);
  }
}

// Atomic in-place replacement: sibling temp file, preserved mode bits, rename.
async function writeFileAtomic(filePath, text) {
  const directory = path.dirname(filePath);
  const base = path.basename(filePath);
  const tempPath = path.join(directory, `.${base}.stegzero-${process.pid}-${Date.now()}.tmp`);
  let mode = 0o666;
  try { mode = (await fs.stat(filePath)).mode & 0o777; } catch (_) {}
  try {
    await fs.writeFile(tempPath, text, { encoding: 'utf8', mode });
    await fs.rename(tempPath, filePath);
  } catch (error) {
    try { await fs.unlink(tempPath); } catch (_) {}
    throw new CliError(EXIT.IO, 'EIO', `Cannot write ${filePath}: ${error.message}`);
  }
}

// Candidate clipboard writers in preference order. Each reads UTF-8 from stdin.
function clipboardCommands() {
  if (process.platform === 'darwin') return [['pbcopy', []]];
  if (process.platform === 'win32') {
    // clip.exe mangles non-ASCII input, so read stdin as UTF-8 in PowerShell.
    const script = '[Console]::InputEncoding=[Text.Encoding]::UTF8;Set-Clipboard -Value ([Console]::In.ReadToEnd())';
    return [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]]];
  }
  const commands = [];
  if (process.env.WAYLAND_DISPLAY) commands.push(['wl-copy', []]);
  commands.push(['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]);
  return commands;
}

function runClipboardCommand(command, args, text) {
  return new Promise(resolve => {
    let child;
    try {
      // stdout/stderr are ignored because wl-copy and xclip fork a background
      // process that keeps serving the selection after this one exits.
      child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch (_) {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('exit', code => resolve(code === 0));
    child.stdin.on('error', () => {});
    child.stdin.end(text, 'utf8');
  });
}

async function copyToClipboard(text) {
  for (const [command, args] of clipboardCommands()) {
    if (await runClipboardCommand(command, args, text)) return;
  }
  const hint = process.platform === 'linux' ? ' Install wl-clipboard, xclip, or xsel, or use --output instead.' : ' Use --output instead.';
  throw new CliError(EXIT.IO, 'ECLIPBOARD', `Could not copy to the clipboard.${hint}`);
}

function promptPassphrase(label) {
  if (!process.stdin.isTTY) {
    throw new CliError(EXIT.USAGE, 'ENOTTY', 'Cannot prompt for a passphrase without a TTY. Use --passphrase-file instead.');
  }
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = chunk => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          cleanup();
          process.stderr.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') { // Ctrl-C
          cleanup();
          process.stderr.write('\n');
          reject(new CliError(EXIT.USAGE, 'EINTR', 'Passphrase entry cancelled.'));
          return;
        }
        if (char === '\u0004') { // Ctrl-D
          cleanup();
          process.stderr.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u007F' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    stdin.on('data', onData);
  });
}

module.exports = {
  decodeBuffer,
  readTextFile,
  readStdin,
  readSecretFile,
  stripOneLineEnding,
  fileExists,
  assertWritable,
  writeOutput,
  writeFileAtomic,
  copyToClipboard,
  promptPassphrase
};
