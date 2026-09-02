import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const VERSION = '17.0.0';
const SOURCES = {
  UnicodeData: ['https://www.unicode.org/Public/17.0.0/ucd/UnicodeData.txt', '2e1efc1dcb59c575eedf5ccae60f95229f706ee6d031835247d843c11d96470c'],
  DerivedCoreProperties: ['https://www.unicode.org/Public/17.0.0/ucd/DerivedCoreProperties.txt', '24c7fed1195c482faaefd5c1e7eb821c5ee1fb6de07ecdbaa64b56a99da22c08'],
  PropList: ['https://www.unicode.org/Public/17.0.0/ucd/PropList.txt', '130dcddcaadaf071008bdfce1e7743e04fdfbc910886f017d9f9ac931d8c64dd'],
  StandardizedVariants: ['https://www.unicode.org/Public/17.0.0/ucd/StandardizedVariants.txt', 'f55100b2fb11d3d75a37b8c1ab752192dbd1c4b12328c5ec6b38e3807c0ca597'],
  DerivedJoiningType: ['https://www.unicode.org/Public/17.0.0/ucd/extracted/DerivedJoiningType.txt', 'f39ebe974825d6736aee15582250307aa532b2cfab3caf3f86bd23fddc9c5c4d'],
  EmojiVariations: ['https://www.unicode.org/Public/17.0.0/ucd/emoji/emoji-variation-sequences.txt', 'bb3d09ef03f206012c7532dd52dc0a21c9efddba0135ea4cf0d9201b8b9bba7e'],
  EmojiSequences: ['https://www.unicode.org/Public/17.0.0/emoji/emoji-sequences.txt', '12cc8267dc33cbd11ed32bcf6fc5dc2ad9c7a77bae1bdfba2f41b1b9b3ead8dd'],
  EmojiZwjSequences: ['https://www.unicode.org/Public/17.0.0/emoji/emoji-zwj-sequences.txt', '5b25441daed2322b068c5e70cda522946a4f0274df864445a1965a92e5fc5cad'],
  EmojiTest: ['https://www.unicode.org/Public/17.0.0/emoji/emoji-test.txt', '1d8a944f88d7952f7ef7c5167fef3c67995bcae24543949710231b03a201acda']
};

async function load(name, url, expectedHash) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actualHash = createHash('sha256').update(bytes).digest('hex');
  if (actualHash !== expectedHash) throw new Error(`${name}: checksum mismatch; expected ${expectedHash}, received ${actualHash}`);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!text.includes(VERSION.replace(/\.0$/, '')) && !text.includes(`Version ${VERSION}`) && name !== 'UnicodeData') {
    throw new Error(`${name}: source does not declare Unicode ${VERSION}`);
  }
  return text;
}

function range(field) {
  const [start, end = start] = field.trim().split('..');
  return [parseInt(start, 16), parseInt(end, 16)];
}

function propertyRanges(text, property) {
  return text.split(/\r?\n/).map(line => line.replace(/#.*/, '').trim()).filter(Boolean).map(line => line.split(';').map(part => part.trim())).filter(parts => parts[1] === property).map(parts => range(parts[0])).sort((a, b) => a[0] - b[0]);
}

function sequences(text, predicate = () => true) {
  return text.split(/\r?\n/).map(line => line.replace(/#.*/, '').trim()).filter(Boolean).map(line => line.split(';').map(part => part.trim())).filter(parts => predicate(parts)).map(parts => parts[0].split(/\s+/).map(value => parseInt(value, 16)));
}

function unicodeRecords(text) {
  const records = [], lines = text.split(/\r?\n/).filter(Boolean);
  let pending = null;
  for (const line of lines) {
    const fields = line.split(';'), cp = parseInt(fields[0], 16), name = fields[1], category = fields[2];
    if (name.endsWith(', First>')) pending = { start: cp, name, category };
    else if (name.endsWith(', Last>') && pending) { records.push([pending.start, cp, pending.category, pending.name]); pending = null; }
    else records.push([cp, cp, category, name]);
  }
  return records;
}

function mergeRanges(ranges) {
  const output = [];
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    const last = output[output.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else output.push([start, end]);
  }
  return output;
}

const loaded = Object.fromEntries(await Promise.all(Object.entries(SOURCES).map(async ([name, [url, hash]]) => [name, await load(name, url, hash)])));
const defaultIgnorable = propertyRanges(loaded.DerivedCoreProperties, 'Default_Ignorable_Code_Point');
const whiteSpace = propertyRanges(loaded.PropList, 'White_Space');
const joiningType = loaded.DerivedJoiningType.split(/\r?\n/).map(line => line.replace(/#.*/, '').trim()).filter(Boolean).map(line => line.split(';').map(part => part.trim())).map(parts => [...range(parts[0]), parts[1]]);
const standardizedVariations = sequences(loaded.StandardizedVariants);
const emojiVariations = sequences(loaded.EmojiVariations);
const emojiZwjSequences = sequences(loaded.EmojiZwjSequences, parts => parts[1] === 'RGI_Emoji_ZWJ_Sequence');
const rgiEmojiSequences = sequences(loaded.EmojiSequences, parts => /^RGI_Emoji_/.test(parts[1]));
const emojiTest = sequences(loaded.EmojiTest, parts => parts[1] === 'fully-qualified');
const records = unicodeRecords(loaded.UnicodeData);
const assigned = mergeRanges(records.map(record => record.slice(0, 2)));
const privateUse = mergeRanges(records.filter(record => record[2] === 'Co').map(record => record.slice(0, 2)));
const marks = mergeRanges(records.filter(record => /^M/.test(record[2])).map(record => record.slice(0, 2)));

const wantedNames = new Set([0x00AD, 0x034F, 0x061C, 0x115F, 0x1160, 0x180E, 0x200B, 0x200C, 0x200D, 0x200E, 0x200F, 0x2028, 0x2029, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x2066, 0x2067, 0x2068, 0x2069, 0x2800, 0x3164, 0xFFA0, 0xFEFF]);
for (const ranges of [defaultIgnorable, whiteSpace]) for (const [start, end] of ranges) for (let cp = start; cp <= end; cp++) wantedNames.add(cp);
const names = {};
for (const line of loaded.UnicodeData.split(/\r?\n/)) {
  const fields = line.split(';');
  const cp = parseInt(fields[0], 16);
  if (wantedNames.has(cp) && fields[1] && !fields[1].startsWith('<')) names[cp] = fields[1];
}

const data = {
  version: VERSION,
  attribution: 'Unicode Character Database © Unicode, Inc. Used under the Unicode Data Files and Software License.',
  sources: Object.fromEntries(Object.entries(SOURCES).map(([name, [url, sha256]]) => [name, { url, sha256 }])),
  defaultIgnorable, whiteSpace, assigned, privateUse, marks, joiningType, names,
  standardizedVariations, emojiVariations, emojiZwjSequences, rgiEmojiSequences, emojiTest
};

const output = `/* Generated by scripts/generate-unicode-inspector-data.mjs. Do not edit. */\n(function(root){'use strict';root.StegZeroUnicodeData=Object.freeze(${JSON.stringify(data)});})(typeof window!=='undefined'?window:globalThis);\n`;
await writeFile(new URL('../unicode-inspector-data.js', import.meta.url), output);
console.log(`Wrote unicode-inspector-data.js (${output.length.toLocaleString()} bytes) from Unicode ${VERSION}.`);
