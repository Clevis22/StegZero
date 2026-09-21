import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const bin = path.join(root, 'bin', 'stegzero.js');
const require = createRequire(import.meta.url);
const protocol = require(path.join(root, 'stegzero-protocol.js'));

delete process.env.NODE_OPTIONS;

function runCli(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: options.cwd || root,
      env: { ...process.env, ...(options.env || {}) }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

async function withTempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'stegzero-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const CARRIER_RE = /[\u200B\u200C\u200D\u2060\u2062\u2063\u2064\uFEFF]/g;

test('hide/reveal round-trips standard ASCII text', async () => {
  const hide = await runCli(['hide', '--cover', 'Meet me at noon', '--message', 'Use the east entrance']);
  assert.equal(hide.code, 0);
  assert.ok(!hide.stdout.includes('Use the east entrance'));
  assert.equal(hide.stderr, '');

  const reveal = await runCli(['reveal'], { input: hide.stdout });
  assert.equal(reveal.code, 0);
  assert.equal(reveal.stdout, 'Use the east entrance');
});

test('hide/reveal round-trips Unicode with emoji, combining marks, RTL, tabs, and newlines', async () => {
  const message = 'e\u0301 नमस्ते اَلْعَرَبِيَّةُ 👩‍👩‍👧‍👦\tline\nend';
  const hide = await runCli(['hide', '--cover', 'Plain cover', '--message', message]);
  const reveal = await runCli(['reveal'], { input: hide.stdout });
  assert.equal(reveal.stdout, message);
});

test('compatibility mode round-trips and only uses ZWSP/ZWNJ carriers', async () => {
  const hide = await runCli(['hide', '--cover', 'Visible', '--message', 'Compatibility secret 🔎', '--mode', 'compatibility']);
  assert.equal(hide.code, 0);
  assert.doesNotMatch(hide.stdout.replace(/[\u200B\u200C]/g, ''), /[\u200D\u2060\u2062\u2063\u2064\uFEFF]/);
  const reveal = await runCli(['reveal'], { input: hide.stdout });
  assert.equal(reveal.stdout, 'Compatibility secret 🔎');
  const json = await runCli(['reveal', '--format', 'json'], { input: hide.stdout });
  assert.deepEqual(JSON.parse(json.stdout), { ok: true, format: 'compatibility', verified: true, message: 'Compatibility secret 🔎' });
});

test('empty cover text is supported', async () => {
  const hide = await runCli(['hide', '--cover', '', '--message', 'hidden']);
  assert.equal(hide.code, 0);
  const reveal = await runCli(['reveal', '--format', 'json'], { input: hide.stdout });
  assert.equal(JSON.parse(reveal.stdout).message, 'hidden');
});

test('leading and trailing whitespace and final newlines are preserved', async () => {
  const message = '  padded secret  \n\n';
  const hide = await runCli(['hide', '--cover', 'Cover', '--message', message]);
  const reveal = await runCli(['reveal'], { input: hide.stdout });
  assert.equal(reveal.stdout, message);
});

test('passphrase-protected round trip via passphrase file', async t => {
  const dir = await withTempDir(t);
  const passFile = path.join(dir, 'pass.txt');
  await writeFile(passFile, 'correct horse\n');
  const hide = await runCli(['hide', '--cover', 'Visible', '--message', 'Secret', '--passphrase-file', passFile]);
  assert.equal(hide.code, 0);

  const ok = await runCli(['reveal', '--passphrase-file', passFile], { input: hide.stdout });
  assert.equal(ok.stdout, 'Secret');
  assert.equal(ok.code, 0);

  const header = await runCli(['reveal', '--format', 'json'], { input: hide.stdout });
  assert.equal(header.code, 4);
  assert.equal(JSON.parse(header.stdout).code, 'PASSPHRASE_REQUIRED');

  const wrongFile = path.join(dir, 'wrong.txt');
  await writeFile(wrongFile, 'wrong');
  const wrong = await runCli(['reveal', '--passphrase-file', wrongFile, '--format', 'json'], { input: hide.stdout });
  assert.equal(wrong.code, 4);
  assert.equal(JSON.parse(wrong.stdout).code, 'PASSPHRASE_MISMATCH');
  assert.ok(!wrong.stdout.includes('Secret'));
});

test('both passphrase sources are rejected', async t => {
  const dir = await withTempDir(t);
  const passFile = path.join(dir, 'pass.txt');
  await writeFile(passFile, 'pass');
  const result = await runCli(['reveal', '--passphrase-file', passFile, '--prompt-passphrase'], { input: 'x' });
  assert.equal(result.code, 2);
});

test('empty passphrase files are rejected instead of creating an unprotected message', async t => {
  const dir = await withTempDir(t);
  const passFile = path.join(dir, 'empty-passphrase.txt');
  await writeFile(passFile, '');
  const result = await runCli(['hide', '--cover', 'Visible', '--message', 'Secret', '--passphrase-file', passFile]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /passphrase cannot be empty/i);
  assert.equal(result.stdout, '');
});

test('cover text already containing carrier characters is rejected', async () => {
  const result = await runCli(['hide', '--cover', 'cover\u2062text', '--message', 'secret']);
  assert.equal(result.code, 5);
  assert.match(result.stderr, /U\+2062/);
});

test('oversized payloads report the existing 65,535-byte limit', async () => {
  const result = await runCli(['hide', '--cover', 'Cover', '--message', 'a'.repeat(65536)]);
  assert.equal(result.code, 5);
  assert.match(result.stderr, /65,535/);
});

test('legacy payloads decode but are marked unverified', async () => {
  const bits = [...new TextEncoder().encode('legacy')].map(byte => byte.toString(2).padStart(8, '0')).join('');
  const encoded = [...bits].map(bit => bit === '0' ? '\u200B' : '\u200C').join('');
  const result = await runCli(['reveal', '--format', 'json'], { input: encoded });
  assert.equal(result.code, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.format, 'legacy');
  assert.equal(payload.verified, false);
  assert.equal(payload.message, 'legacy');

  const text = await runCli(['reveal'], { input: encoded });
  assert.equal(text.stdout, 'legacy');
  assert.match(text.stderr, /legacy/i);
});

test('an undecodable payload returns NO_PAYLOAD with exit code 1', async () => {
  const result = await runCli(['reveal', '--format', 'json'], { input: 'just ordinary text' });
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, code: 'NO_PAYLOAD', error: 'No StegZero payload was found.' });
});

test('message can be read from stdin while the cover is a flag', async () => {
  const hide = await runCli(['hide', '--cover', 'Visible cover'], { input: 'piped secret' });
  const reveal = await runCli(['reveal'], { input: hide.stdout });
  assert.equal(reveal.stdout, 'piped secret');
});

test('cover can be read from stdin when only the message is supplied', async () => {
  const hide = await runCli(['hide', '--message', 'from flag'], { input: 'stdin cover' });
  assert.equal(hide.code, 0);
  const reveal = await runCli(['reveal', '--format', 'json'], { input: hide.stdout });
  assert.equal(JSON.parse(reveal.stdout).message, 'from flag');
});

test('conflicting source combinations are rejected with exit code 2', async () => {
  const both = await runCli(['hide', '--cover', 'a', '--cover-file', 'x', '--message', 'm']);
  assert.equal(both.code, 2);
  const positionals = await runCli(['hide', 'extra', '--cover', 'a', '--message', 'm']);
  assert.equal(positionals.code, 2);
  const emptyMessage = await runCli(['hide', '--cover', 'a', '--message', '']);
  assert.equal(emptyMessage.code, 2);
});

test('existing output files are protected unless --force is used', async t => {
  const dir = await withTempDir(t);
  const out = path.join(dir, 'encoded.txt');
  await writeFile(out, 'existing');
  const blocked = await runCli(['hide', '--cover', 'a', '--message', 'm', '--output', out]);
  assert.equal(blocked.code, 2);
  assert.equal(await readFile(out, 'utf8'), 'existing');
  const forced = await runCli(['hide', '--cover', 'a', '--message', 'm', '--output', out, '--force']);
  assert.equal(forced.code, 0);
  assert.notEqual(await readFile(out, 'utf8'), 'existing');
});

test('hidden and revealed messages are never mixed with diagnostics', async () => {
  const hide = await runCli(['hide', '--cover', 'Cover', '--message', 'payload']);
  // Encoded stdout must contain no prose labels.
  assert.doesNotMatch(hide.stdout, /[A-Za-z]{3,}/, 'unexpected label text in encoded output');
  assert.equal(hide.stderr, '');
});

test('web-generated fixtures decode in the CLI', async () => {
  const standard = protocol.encodeMsg('Website cover', 'from the browser', null);
  const binary = protocol.encodeMsgBinary('Website cover', 'binary browser', null);
  assert.equal((await runCli(['reveal'], { input: standard })).stdout, 'from the browser');
  assert.equal((await runCli(['reveal'], { input: binary })).stdout, 'binary browser');
});

test('broken-pipe output exits cleanly', async () => {
  const script = `const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['${bin}', 'hide', '--cover', ${JSON.stringify('c'.repeat(50000))}, '--message', 'secret']);
    child.stdout.on('data', () => { child.stdout.destroy(); });
    child.on('close', code => process.stdout.write(String(code)));`;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script]);
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', reject);
    child.on('close', () => resolve(out));
  });
  assert.equal(result, '0');
});

test('inspect reports no findings for plain text and exits 0', async () => {
  const result = await runCli(['inspect'], { input: 'ordinary text' });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Findings: 0/);
});

test('inspect flags bidi controls and exits 1', async () => {
  const result = await runCli(['inspect'], { input: 'a\u202Eb' });
  assert.equal(result.code, 1);
  assert.ok(!result.stdout.includes('\u202E'), 'raw bidi control leaked into report');
  assert.match(result.stdout, /\[RLO\]/);
});

test('inspect JSON report has a stable top-level shape with StegZero metadata', async () => {
  const encoded = (await runCli(['hide', '--cover', 'Cover', '--message', 'hidden'])).stdout;
  const result = await runCli(['inspect', '--format', 'json'], { input: encoded });
  const report = JSON.parse(result.stdout);
  assert.equal(report.unicodeVersion, '17.0.0');
  assert.equal(typeof report.input.codePoints, 'number');
  assert.ok(report.summary);
  assert.ok(Array.isArray(report.findings));
  assert.equal(report.stegzero.format, 'standard');
  assert.equal(report.stegzero.status, 'decoded');
});

test('clean presets match direct engine calls', async () => {
  const engines = require(path.join(root, 'lib', 'node-engines.js'));
  const value = 'a\u0000b\u202Ec\u00A0d';
  for (const preset of ['conservative', 'security', 'aggressive']) {
    const cli = await runCli(['clean', '--preset', preset, '--context', 'source'], { input: value });
    const report = engines.unicode.inspect(value, { context: 'source' });
    const expected = engines.unicode.clean(value, report, { preset }).text;
    assert.equal(cli.stdout, expected, preset);
  }
});

test('clean preserves valid emoji tag sequences under conservative cleanup', async () => {
  const cp = value => String.fromCodePoint(value);
  const flag = cp(0x1F3F4) + [...'gbeng'].map(c => cp(0xE0000 + c.codePointAt(0))).join('') + cp(0xE007F);
  const invalid = [...'hide'].map(c => cp(0xE0000 + c.codePointAt(0))).join('');
  const result = await runCli(['clean'], { input: flag + ' ' + invalid });
  assert.equal(result.stdout, flag + ' ');
});

test('clean --in-place is atomic and rejects stdin', async t => {
  const dir = await withTempDir(t);
  const file = path.join(dir, 'suspicious.txt');
  const source = 'a\u0000b';
  await writeFile(file, source);
  const noPath = await runCli(['clean', '--in-place'], { input: source });
  assert.equal(noPath.code, 2);

  const result = await runCli(['clean', '--in-place', file]);
  assert.equal(result.code, 0);
  assert.equal(await readFile(file, 'utf8'), 'ab');
  assert.match(result.stderr, /1 change/);

  const withOutput = await runCli(['clean', '--in-place', '--output', 'x', file]);
  assert.equal(withOutput.code, 2);
});

test('clean --in-place preserves file mode bits', async t => {
  const dir = await withTempDir(t);
  const file = path.join(dir, 'mode.txt');
  await writeFile(file, 'a\u0000b', { mode: 0o640 });
  await runCli(['clean', '--in-place', file]);
  const mode = (await stat(file)).mode & 0o777;
  assert.equal(mode, 0o640);
});

test('watermark round-trips text, JSON, and CSV files', async t => {
  const dir = await withTempDir(t);
  const cases = [
    ['note.txt', 'alpha\nbeta', 'build:123'],
    ['data.json', '{"name":"Alice","count":1}', 'json:42'],
    ['data.csv', '"a""b\nnext",42', 'csv:7']
  ];
  for (const [name, source, id] of cases) {
    const file = path.join(dir, name);
    await writeFile(file, source);
    const add = await runCli(['watermark', 'add', file, '--id', id, '--in-place']);
    assert.equal(add.code, 0, name);
    const check = await runCli(['watermark', 'check', file]);
    assert.equal(check.stdout, id + '\n', name);
    assert.equal(check.code, 0, name);
    if (name.endsWith('.json')) {
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), JSON.parse(source));
    }
  }
});

test('watermark check JSON output is stable and reports absence', async () => {
  const plain = await runCli(['watermark', 'check', '--format', 'json'], { input: 'no watermark here' });
  assert.equal(plain.code, 1);
  assert.deepEqual(JSON.parse(plain.stdout), { ok: false, watermarked: false, code: 'NO_WATERMARK', error: 'No StegZero watermark was found.' });
});

test('watermark rejects malformed JSON', async t => {
  const dir = await withTempDir(t);
  const file = path.join(dir, 'broken.json');
  await writeFile(file, '{broken');
  const result = await runCli(['watermark', 'add', file, '--id', 'x', '--in-place']);
  assert.equal(result.code, 5);
  assert.match(result.stderr, /valid JSON/);
});

test('watermark rejects malformed CSV', async t => {
  const dir = await withTempDir(t);
  const file = path.join(dir, 'broken.csv');
  await writeFile(file, '"unterminated');
  const result = await runCli(['watermark', 'add', file, '--id', 'x', '--in-place']);
  assert.equal(result.code, 5);
  assert.match(result.stderr, /CSV/);
});

test('browser can decode CLI-generated standard and compatibility output', async () => {
  const standard = await runCli(['hide', '--cover', 'Cover', '--message', 'cli standard']);
  const compatibility = await runCli(['hide', '--cover', 'Cover', '--message', 'cli compat', '--mode', 'compatibility']);
  assert.equal(protocol.tryDecodeV2(standard.stdout, null), 'cli standard');
  assert.equal(protocol.tryDecodeBinary(compatibility.stdout, null), 'cli compat');
});

test('--version and help are available', async () => {
  const version = await runCli(['--version']);
  assert.match(version.stdout, /^\d+\.\d+\.\d+/);
  const help = await runCli(['help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Exit codes:/);
  const hideHelp = await runCli(['hide', '--help']);
  assert.equal(hideHelp.code, 0);
  assert.match(hideHelp.stdout, /--cover-file/);
  const watermarkHelp = await runCli(['watermark', 'check', 'help']);
  assert.equal(watermarkHelp.code, 0);
  assert.match(watermarkHelp.stdout, /--format/);
  const unknown = await runCli(['bogus']);
  assert.equal(unknown.code, 2);
});

test('empty watermark IDs are rejected', async t => {
  const dir = await withTempDir(t);
  const input = path.join(dir, 'input.txt');
  const output = path.join(dir, 'output.txt');
  await writeFile(input, 'Visible text');
  const result = await runCli(['watermark', 'add', input, '--id', '', '--output', output]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /watermark ID cannot be empty/i);
});

test('watermark round-trips HTML and XML without breaking structure', async () => {
  const engines = require(path.join(root, 'lib', 'node-engines.js'));
  const cases = [
    ['html', '<!doctype html><html><script>const answer = 42;</script><p>Hi</p></html>'],
    ['xml', '<?xml version="1.0" encoding="UTF-8"?><root><value>42</value></root>']
  ];
  const dir = await mkdtemp(path.join(tmpdir(), 'stegzero-cli-'));
  try {
    for (const [type, source] of cases) {
      const file = path.join(dir, `doc.${type}`);
      await writeFile(file, source);
      const add = await runCli(['watermark', 'add', file, '--id', 'doc:42', '--type', type, '--in-place']);
      assert.equal(add.code, 0, type);
      const output = await readFile(file, 'utf8');
      assert.equal(engines.protocol.wmDecode(output), 'doc:42', type);
      assert.equal(output.replace(/<!--[\s\S]*?-->/, ''), source, type);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a confirmed StegZero payload is removed only under the security policy or --remove-stegzero', async () => {
  const encoded = (await runCli(['hide', '--cover', 'Cover', '--message', 'hidden'])).stdout;
  const conservative = await runCli(['clean'], { input: encoded });
  assert.equal(conservative.stdout, encoded);
  const security = await runCli(['clean', '--preset', 'security'], { input: encoded });
  assert.equal(security.stdout, 'Cover');
  const explicit = await runCli(['clean', '--remove-stegzero'], { input: encoded });
  assert.equal(explicit.stdout, 'Cover');
});

test('damaged protected frames are reported as damaged', async () => {
  const encoded = protocol.encodeMsg('', 'hidden', 'pw');
  const chars = [...encoded];
  const truncated = chars.slice(0, Math.floor(chars.length * 0.7)).join('');
  const result = await runCli(['reveal', '--format', 'json'], { input: truncated });
  assert.equal(result.code, 5);
  assert.equal(JSON.parse(result.stdout).code, 'DAMAGED_PAYLOAD');
});

test('inspect rejects input beyond the code-point limit', async () => {
  const result = await runCli(['inspect'], { input: 'a'.repeat(500001) });
  assert.equal(result.code, 5);
  assert.match(result.stderr, /500,000/);
});
