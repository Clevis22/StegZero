import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { TextDecoder, TextEncoder } from 'node:util';

const context = vm.createContext({ TextDecoder, TextEncoder, Uint8Array, console });
vm.runInContext(await readFile(new URL('../unicode-inspector-data.js', import.meta.url), 'utf8'), context);
vm.runInContext(await readFile(new URL('../unicode-inspector.js', import.meta.url), 'utf8'), context);
vm.runInContext(await readFile(new URL('../unicode-inspector-ui.js', import.meta.url), 'utf8'), context);
const unicode = context.StegZeroUnicode;
const ui = context.StegZeroInspectorUI;

const cp = value => String.fromCodePoint(value);
const inspect = (value, options) => unicode.inspect(value, options);

test('pins Unicode 17 data and reports empty input without claiming safety', () => {
  const report = inspect('ordinary text');
  assert.equal(report.unicodeVersion, '17.0.0');
  assert.equal(report.summary.findingCount, 0);
  assert.equal(report.summary.highestAssessment, null);
});

test('classifies the primary categories and range boundaries', () => {
  const samples = new Map([
    [0x202E, 'bidi-control'], [0xE0000, 'unicode-tag'], [0xE007F, 'unicode-tag'],
    [0xFE00, 'variation-selector'], [0xE01EF, 'variation-selector'], [0x200C, 'join-control'],
    [0x00AD, 'line-word-format'], [0x2061, 'invisible-math'], [0x0000, 'control-code'],
    [0x00A0, 'unusual-whitespace'], [0x2800, 'blank-filler'], [0x206A, 'deprecated-format']
  ]);
  for (const [value, category] of samples) assert.equal(inspect(cp(value)).findings[0].category, category, `U+${value.toString(16)}`);
});

test('uses code-point positions and UTF-16 offsets after supplementary characters', () => {
  const report = inspect('😀a' + cp(0x200B));
  const finding = report.findings[0];
  assert.equal(finding.codePointIndex, 3);
  assert.equal(finding.utf16Offset, 3);
  assert.equal(finding.line, 1);
  assert.equal(finding.column, 3);
});

test('tracks line and code-point column across LF and CRLF', () => {
  const report = inspect('a\r\n' + cp(0x200B) + '\n' + cp(0x0000));
  assert.deepEqual(Array.from(report.findings, f => [f.line, f.column]), [[2, 1], [3, 1]]);
});

test('distinguishes initial and mid-text FEFF', () => {
  const report = inspect(cp(0xFEFF) + 'a' + cp(0xFEFF));
  assert.equal(report.findings[0].assessment, 'expected');
  assert.equal(report.findings[1].assessment, 'review');
});

test('detects balanced, unmatched, nested, and unterminated bidi controls', () => {
  const balanced = inspect(cp(0x2066) + 'abc' + cp(0x2069));
  assert.ok(balanced.findings.every(f => f.assessment !== 'suspicious'));
  const unmatched = inspect('abc' + cp(0x2069));
  assert.equal(unmatched.findings[0].assessment, 'suspicious');
  const unterminated = inspect(cp(0x202A) + cp(0x2066) + 'abc');
  assert.ok(unterminated.findings.every(f => f.assessment === 'suspicious'));
});

test('recognizes RGI subdivision flag tag sequences and rejects detached tags', () => {
  const tags = [...'gbeng'].map(char => cp(0xE0000 + char.codePointAt(0))).join('');
  const valid = inspect(cp(0x1F3F4) + tags + cp(0xE007F));
  assert.ok(valid.findings.every(f => f.assessment === 'expected'));
  assert.equal(valid.candidates.length, 0);
  const detached = inspect(tags + cp(0xE007F));
  assert.equal(detached.candidates[0].codec, 'unicode-tags-ascii');
  assert.equal(detached.candidates[0].decodedText, 'gbeng');
});

test('validates emoji variation sequences and preserves CJK supplementary selectors', () => {
  assert.equal(inspect('❤' + cp(0xFE0F)).findings[0].assessment, 'expected');
  const cjk = inspect('漢' + cp(0xE0100)).findings[0];
  assert.equal(cjk.contextKind, 'possible-ideographic-variation');
  assert.equal(cjk.cleanupDefault, 'preserve');
  assert.equal(inspect(cp(0xFE0F)).findings[0].assessment, 'suspicious');
});

test('reconstructs variation-selector bytes only under cautious validation', () => {
  const selectors = new TextEncoder().encode('test').reduce((out, byte) => out + cp(byte < 16 ? 0xFE00 + byte : 0xE0100 + byte - 16), '');
  const report = inspect(selectors);
  assert.equal(report.candidates[0].codec, 'variation-selector-bytes');
  assert.equal(report.candidates[0].decodedText, 'test');
  const invalid = inspect(cp(0xE0100) + cp(0xE0101) + cp(0xE0102) + cp(0xE0103));
  assert.equal(invalid.candidates.length, 0);
});

test('strengthens source and identifier assessments without changing detection', () => {
  const value = 'a' + cp(0x00A0) + 'b';
  assert.equal(inspect(value, { context: 'plain' }).findings[0].assessment, 'review');
  assert.equal(inspect(value, { context: 'source' }).findings[0].assessment, 'suspicious');
  assert.equal(inspect(value, { context: 'identifier' }).findings[0].assessment, 'suspicious');
});

test('advanced anomalies are optional and never automatically cleaned', () => {
  const value = cp(0xE000);
  assert.equal(inspect(value).findings.length, 0);
  const report = inspect(value, { includeAdvanced: true });
  assert.equal(report.findings[0].category, 'private-use');
  assert.equal(unicode.clean(value, report, { preset: 'conservative' }).text, value);
});

test('conservative cleaning is finding-specific and preserves valid emoji tags', () => {
  const validTags = [...'gbeng'].map(char => cp(0xE0000 + char.codePointAt(0))).join('') + cp(0xE007F);
  const invalidTags = [...'hide'].map(char => cp(0xE0000 + char.codePointAt(0))).join('');
  const value = cp(0x1F3F4) + validTags + ' ' + invalidTags + cp(0x0000);
  const report = inspect(value);
  const cleaned = unicode.clean(value, report, { preset: 'conservative' }).text;
  assert.ok(cleaned.includes(cp(0x1F3F4) + validTags));
  assert.ok(!cleaned.includes(invalidTags));
  assert.ok(!cleaned.includes(cp(0x0000)));
});

test('cleaning is deterministic and idempotent', () => {
  const value = 'a' + cp(0x202E) + 'b' + cp(0x0000) + cp(0x00A0);
  const firstReport = inspect(value, { context: 'source' });
  const first = unicode.clean(value, firstReport, { preset: 'security' }).text;
  const second = unicode.clean(first, inspect(first, { context: 'source' }), { preset: 'security' }).text;
  assert.equal(first, second);
});

test('aggressive cleanup normalizes unusual spaces and separators', () => {
  const value = 'a' + cp(0x00A0) + 'b' + cp(0x2028) + 'c';
  const result = unicode.clean(value, inspect(value), { preset: 'aggressive' });
  assert.equal(result.text, 'a b\nc');
  assert.equal(result.changes, 2);
  assert.deepEqual(Array.from(result.changeDetails, detail => [detail.action, detail.replacement, detail.count]), [
    ['replace', ' ', 1], ['replace', '\n', 1]
  ]);
  assert.equal(result.changedFindingIds.length, 2);
});

test('cleanup reports grouped removals for an explainable preview', () => {
  const value = 'a' + cp(0x0000) + cp(0x0000) + 'b';
  const report = inspect(value);
  const result = unicode.clean(value, report, { preset: 'conservative' });
  assert.equal(result.text, 'ab');
  assert.equal(result.changeDetails.length, 1);
  assert.equal(result.changeDetails[0].action, 'remove');
  assert.equal(result.changeDetails[0].count, 2);
  assert.deepEqual(Array.from(result.changeDetails[0].findingIds), ['f2', 'f3']);
});

test('escaped views and reports do not emit raw bidi controls', () => {
  const value = 'a' + cp(0x202E) + 'b';
  const report = inspect(value);
  assert.equal(unicode.escapedView(value, report), 'a[RLO]b');
  assert.ok(!unicode.formatReport(report, 'text').includes(cp(0x202E)));
  assert.equal(JSON.parse(unicode.formatReport(report, 'json')).unicodeVersion, '17.0.0');
});

test('enforces the maximum code-point count', () => {
  assert.throws(() => inspect('a'.repeat(500001)), /500,000/);
});

test('local file decoder accepts UTF-8 and BOM-marked UTF-16 without replacement decoding', () => {
  assert.equal(ui.decodeLocalFile(Uint8Array.from([0xEF, 0xBB, 0xBF, 0x68, 0x69]).buffer), 'hi');
  assert.equal(ui.decodeLocalFile(Uint8Array.from([0xFF, 0xFE, 0x68, 0, 0x69, 0]).buffer), 'hi');
  assert.equal(ui.decodeLocalFile(Uint8Array.from([0xFE, 0xFF, 0, 0x68, 0, 0x69]).buffer), 'hi');
  assert.throws(() => ui.decodeLocalFile(Uint8Array.from([0xC3, 0x28]).buffer), /not valid/);
  assert.throws(() => ui.decodeLocalFile(Uint8Array.from([0, 1, 2, 3]).buffer), /binary/);
});
