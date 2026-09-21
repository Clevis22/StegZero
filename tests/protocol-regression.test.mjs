import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { TextDecoder, TextEncoder } from 'node:util';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
const source = await readFile(new URL('../stegzero-protocol.js', import.meta.url), 'utf8') + '\n' + scripts.at(-1)[1] + '\n;globalThis.__protocol={encodeMsg,tryDecodeV2,getV2Header,encodeMsgBinary,tryDecodeBinary,getBinaryHeader,tryDecodeLegacy,wmEncode,wmDecode};';
const stub = () => ({
  style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  addEventListener() {}, querySelectorAll() { return []; }, setAttribute() {}, append() {}, click() {},
  textContent: '', value: '', checked: false, disabled: false, files: []
});
const document = {
  getElementById() { return stub(); }, querySelector() { return stub(); }, querySelectorAll() { return []; },
  addEventListener() {}, createElement() { return stub(); }, body: { style: {} }
};
const context = vm.createContext({
  TextEncoder, TextDecoder, Uint8Array, Uint32Array, Map, Set, Math, crypto: crypto.webcrypto,
  document, window: { addEventListener() {}, innerWidth: 1200 }, navigator: {}, Blob, URL, setTimeout, clearTimeout
});
vm.runInContext(source, context, { filename: 'index-inline.js' });
const protocol = context.__protocol;

test('Standard mode round-trips plain, Unicode, and passphrase payloads', () => {
  for (const passphrase of [null, 'correct horse']) {
    const hidden = 'Unicode secret 🔎';
    const encoded = protocol.encodeMsg('Visible text', hidden, passphrase);
    assert.equal(protocol.tryDecodeV2(encoded, passphrase), hidden);
    if (passphrase) {
      assert.equal(protocol.getV2Header(encoded).version, 3);
      assert.equal(protocol.tryDecodeV2(encoded, null), null);
      assert.equal(protocol.tryDecodeV2(encoded, 'wrong-passphrase'), null);
    }
  }
});

test('Compatibility mode round-trips plain, Unicode, and passphrase payloads', () => {
  for (const passphrase of [null, 'correct horse']) {
    const hidden = 'Compatibility secret 🔎';
    const encoded = protocol.encodeMsgBinary('Visible text', hidden, passphrase);
    assert.equal(protocol.tryDecodeBinary(encoded, passphrase), hidden);
    if (passphrase) {
      assert.equal(protocol.getBinaryHeader(encoded).version, 3);
      assert.equal(protocol.tryDecodeBinary(encoded, null), null);
      assert.equal(protocol.tryDecodeBinary(encoded, 'wrong-passphrase'), null);
    }
  }
});

test('authenticated passphrase payloads reject printable wrong-passphrase output', () => {
  const hidden = 'Bring the blue notebook.';
  const encoded = protocol.encodeMsg('Meet me by the old fountain at noon.', hidden, 'dinner-secret');
  assert.equal(protocol.tryDecodeV2(encoded, 'wrong'), null);
  assert.equal(protocol.tryDecodeV2(encoded, 'dinner-secret'), hidden);
});

test('framed payloads preserve combining marks, complex scripts, and format characters', () => {
  const samples = [
    'e\u0301',
    'नमस्ते दुनिया',
    'اَلْعَرَبِيَّةُ',
    'Family: 👩‍👩‍👧‍👦',
    'Keycap: 1️⃣',
    'Persian: می‌روم'
  ];
  for (const sample of samples) {
    for (const passphrase of [null, 'full-unicode-passphrase']) {
      const standard = protocol.encodeMsg('Visible cover', sample, passphrase);
      const compatibility = protocol.encodeMsgBinary('Visible cover', sample, passphrase);
      assert.equal(protocol.tryDecodeV2(standard, passphrase), sample);
      assert.equal(protocol.tryDecodeBinary(compatibility, passphrase), sample);
    }
  }
});

test('version 3 binds passphrase bytes that do not participate in repeating XOR', () => {
  const correct = 'abcdefghijklmnopX';
  const wrongSuffix = 'abcdefghijklmnopY';
  for (const mode of ['standard', 'binary']) {
    const encode = mode === 'standard' ? protocol.encodeMsg : protocol.encodeMsgBinary;
    const decode = mode === 'standard' ? protocol.tryDecodeV2 : protocol.tryDecodeBinary;
    const encoded = encode('Cover', 'a', correct);
    assert.equal(decode(encoded, correct), 'a');
    assert.equal(decode(encoded, wrongSuffix), null);
  }
});

test('existing StegZero carrier characters in cover text or source files are rejected', () => {
  assert.throws(() => protocol.encodeMsg('cover\u2062text', 'secret', null), /U\+2062/);
  assert.throws(() => protocol.encodeMsgBinary('cover\u200Btext', 'secret', null), /U\+200B/);
  assert.throws(() => protocol.wmEncode('file\u200Dtext', 'build:123', 'text'), /U\+200D/);
});

test('payloads that exceed the 16-bit framed length are rejected before encoding', () => {
  assert.throws(() => protocol.encodeMsg('Cover', 'a'.repeat(65536), null), /65,535 encoded bytes/);
  assert.throws(() => protocol.encodeMsgBinary('Cover', 'a'.repeat(65524), 'pass'), /65,535 encoded bytes/);
});

test('version 1 passphrase payloads remain decodable for backward compatibility', () => {
  function encodeVersion1(mode, visible, hidden, passphrase) {
    const magic = mode === 'binary' ? 0xB100 : 0xA55A;
    const nonce = 0x1234;
    const bytes = context.xorWithKey(new TextEncoder().encode(hidden), passphrase);
    const header = context.buildHeader(nonce, bytes, 1, magic);
    const bits = context.bytesToBits(header) + context.obfuscateBits(context.bytesToBits(bytes), ((nonce << 16) | magic) >>> 0);
    const payload = mode === 'binary' ? context.bitsToBinary(bits) : context.bitsToAlphabet(bits);
    return context.interleavePayload(visible, payload);
  }
  const standard = encodeVersion1('v2', 'Visible', 'old standard secret', 'old-pass');
  const compatibility = encodeVersion1('binary', 'Visible', 'old compatibility secret', 'old-pass');
  assert.equal(protocol.getV2Header(standard).version, 1);
  assert.equal(protocol.tryDecodeV2(standard, 'old-pass'), 'old standard secret');
  assert.equal(protocol.getBinaryHeader(compatibility).version, 1);
  assert.equal(protocol.tryDecodeBinary(compatibility, 'old-pass'), 'old compatibility secret');
});

test('version 2 authenticated passphrase payloads remain decodable for backward compatibility', () => {
  function encodeVersion2(mode, visible, hidden, passphrase) {
    const magic = mode === 'binary' ? 0xB100 : 0xA55A;
    const nonce = 0x5678;
    const wrapped = context.wrapPassphrasePayload(new TextEncoder().encode(hidden));
    const bytes = context.xorWithKey(wrapped, passphrase);
    const header = context.buildHeader(nonce, bytes, 2, magic);
    const bits = context.bytesToBits(header) + context.obfuscateBits(context.bytesToBits(bytes), ((nonce << 16) | magic) >>> 0);
    const payload = mode === 'binary' ? context.bitsToBinary(bits) : context.bitsToAlphabet(bits);
    return context.interleavePayload(visible, payload);
  }
  const standard = encodeVersion2('v2', 'Visible', 'old V2 standard secret', 'old-v2-pass');
  const compatibility = encodeVersion2('binary', 'Visible', 'old V2 compatibility secret', 'old-v2-pass');
  assert.equal(protocol.getV2Header(standard).version, 2);
  assert.equal(protocol.tryDecodeV2(standard, 'old-v2-pass'), 'old V2 standard secret');
  assert.equal(protocol.getBinaryHeader(compatibility).version, 2);
  assert.equal(protocol.tryDecodeBinary(compatibility, 'old-v2-pass'), 'old V2 compatibility secret');
});

test('legacy fallback accepts valid UTF-8 and rejects malformed bytes', () => {
  const bits = [...new TextEncoder().encode('legacy')].map(byte => byte.toString(2).padStart(8, '0')).join('');
  const encoded = [...bits].map(bit => bit === '0' ? '\u200B' : '\u200C').join('');
  assert.equal(protocol.tryDecodeLegacy(encoded), 'legacy');
  const malformed = '11111111'.split('').map(bit => bit === '0' ? '\u200B' : '\u200C').join('');
  assert.equal(protocol.tryDecodeLegacy(malformed), null);
  assert.equal(protocol.tryDecodeLegacy(encoded + '\u200B'), null);
});

test('file watermark embedding and verification remain compatible', () => {
  const watermarked = protocol.wmEncode('alpha\nbeta', 'build:123', 'txt');
  assert.equal(protocol.wmDecode(watermarked), 'build:123');
});

test('JSON watermarks preserve parsed values and existing file contents', () => {
  for (const source of ['{"name":"Alice","count":1}', '[1,{"nested":[true,null,"😀"]}]', '42', '"hello"', 'false', 'null', ' {"a":1} \r\n\t']) {
    const output = protocol.wmEncode(source, 'build:123 🔎', 'json');
    assert.ok(output.startsWith(source));
    assert.deepEqual(JSON.parse(output), JSON.parse(source));
    assert.equal(protocol.wmDecode(output), 'build:123 🔎');
    assert.throws(() => protocol.wmEncode(output, 'second-id', 'json'), /already contains/);
  }
  assert.throws(() => protocol.wmEncode('{broken', 'id', 'json'), /not valid JSON/);
  assert.equal(protocol.wmDecode('{"a":1}\n' + ' '.repeat(200) + '\n'), null);
  const output = protocol.wmEncode('{}', 'id', 'json');
  const at = output.indexOf('\n') + 40;
  const corrupted = output.slice(0, at) + (output[at] === ' ' ? '\t' : ' ') + output.slice(at + 1);
  assert.equal(protocol.wmDecode(corrupted), null);
});

test('HTML/XML watermarks preserve scripts, styles, doctypes, and declarations', () => {
  for (const [type, source] of [
    ['html', '<!doctype html><html><script>const answer = 42;</script><style>p { color:red }</style><p>Hi</p></html>'],
    ['html', '<script>const unclosed = 42;'],
    ['xml', '<?xml version="1.0" encoding="UTF-8"?><root><value>42</value></root>'],
    ['xml', '<!DOCTYPE root><root/>']
  ]) {
    const output = protocol.wmEncode(source, 'doc:42', type);
    assert.equal(protocol.wmDecode(output), 'doc:42');
    assert.equal(output.replace(/<!--[\s\S]*?-->/, ''), source);
    if (source.startsWith('<?xml')) assert.ok(output.startsWith(source.slice(0, source.indexOf('?>') + 2)));
    const script = output.match(/<script>([\s\S]*?)<\/script>/);
    if (script) assert.doesNotThrow(() => new vm.Script(script[1]));
  }
});

test('CSV watermark placement respects quoted commas, escaped quotes, and multiline fields', () => {
  for (const source of ['name,count\r\nAlice,42', '"name","count"\r\n"Alice, A.",42', '"a""b\nnext",42', '1,2\n3,4', '"",name\n1,2', '']) {
    const output = protocol.wmEncode(source, 'csv:42', 'csv');
    assert.equal(protocol.wmDecode(output), 'csv:42');
    assert.equal(output.replace(/[\u200B\u200C\u200D\u2060\u2062\u2063\u2064\uFEFF]/g, ''), source);
  }
  for (const source of ['"unterminated', '"closed"oops,1', 'ba"re,2']) {
    assert.throws(() => protocol.wmEncode(source, 'id', 'csv'), /CSV/);
  }
});

test('encoding limits include cover code points, byte size, and passphrase metadata', () => {
  const plain = protocol.encodeMsgBinary('', 'a'.repeat(62489), null);
  assert.equal(Array.from(plain).length, 500000);
  assert.equal(protocol.tryDecodeBinary(plain, null), 'a'.repeat(62489));
  assert.throws(() => protocol.encodeMsgBinary('x', 'a'.repeat(62489), null), /500,000/);
  assert.throws(() => protocol.encodeMsgBinary('Cover', 'a'.repeat(62500), null), /500,000/);
  const protectedText = protocol.encodeMsgBinary('', 'a'.repeat(62477), 'pass');
  assert.equal(Array.from(protectedText).length, 500000);
  assert.equal(protocol.tryDecodeBinary(protectedText, 'pass'), 'a'.repeat(62477));
  assert.throws(() => protocol.encodeMsgBinary('', 'a'.repeat(62478), 'pass'), /500,000/);
  const emojiCover = '😀'.repeat(500000 - 32);
  assert.equal(Array.from(protocol.encodeMsg(emojiCover, 'a', null)).length, 500000);
  assert.throws(() => protocol.encodeMsg(emojiCover + 'x', 'a', null), /500,000/);
});

test('large previews are bounded without changing the encoded output', () => {
  for (const [encode, render, decode] of [[protocol.encodeMsg, context.renderPreviewV2, protocol.tryDecodeV2], [protocol.encodeMsgBinary, context.renderPreviewBinary, protocol.tryDecodeBinary]]) {
    const message = 'a'.repeat(4000);
    const encoded = encode('<cover>😀', message, null);
    const preview = render(encoded);
    assert.ok((preview.match(/class="zw-mark/g) || []).length <= 2000);
    assert.match(preview, /Preview limited to the first 2,000 characters/);
    assert.ok(preview.includes('&lt;'));
    assert.equal(decode(encoded, null), message);
    assert.doesNotMatch(render('<short>😀'), /Preview limited/);
  }
});

test('watermarks produced before these changes remain readable', async () => {
  const fixtures = JSON.parse(await readFile(new URL('fixtures/legacy-watermarks.json', import.meta.url), 'utf8'));
  for (const fixture of fixtures) assert.equal(protocol.wmDecode(fixture.watermarked), fixture.id, fixture.format);
});
