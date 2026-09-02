import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { TextDecoder, TextEncoder } from 'node:util';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
const source = scripts.at(-1)[1] + '\n;globalThis.__protocol={encodeMsg,tryDecodeV2,getV2Header,encodeMsgBinary,tryDecodeBinary,getBinaryHeader,tryDecodeLegacy,wmEncode,wmDecode};';
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

test('V2 round-trips plain, Unicode, and passphrase payloads', () => {
  for (const passphrase of [null, 'correct horse']) {
    const hidden = 'Unicode secret 🔎';
    const encoded = protocol.encodeMsg('Visible text', hidden, passphrase);
    assert.equal(protocol.tryDecodeV2(encoded, passphrase), hidden);
    if (passphrase) {
      assert.equal(protocol.getV2Header(encoded).version, 2);
      assert.equal(protocol.tryDecodeV2(encoded, null), null);
      assert.equal(protocol.tryDecodeV2(encoded, 'wrong-passphrase'), null);
    }
  }
});

test('Compatibility/Binary round-trips plain, Unicode, and passphrase payloads', () => {
  for (const passphrase of [null, 'correct horse']) {
    const hidden = 'Compatibility secret 🔎';
    const encoded = protocol.encodeMsgBinary('Visible text', hidden, passphrase);
    assert.equal(protocol.tryDecodeBinary(encoded, passphrase), hidden);
    if (passphrase) {
      assert.equal(protocol.getBinaryHeader(encoded).version, 2);
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

test('legacy fallback accepts valid UTF-8 and rejects malformed bytes', () => {
  const bits = [...new TextEncoder().encode('legacy')].map(byte => byte.toString(2).padStart(8, '0')).join('');
  const encoded = [...bits].map(bit => bit === '0' ? '\u200B' : '\u200C').join('');
  assert.equal(protocol.tryDecodeLegacy(encoded), 'legacy');
  const malformed = '11111111'.split('').map(bit => bit === '0' ? '\u200B' : '\u200C').join('');
  assert.equal(protocol.tryDecodeLegacy(malformed), null);
});

test('file watermark embedding and verification remain compatible', () => {
  const watermarked = protocol.wmEncode('alpha\nbeta', 'build:123', 'txt');
  assert.equal(protocol.wmDecode(watermarked), 'build:123');
});
