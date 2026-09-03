import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const homepage = await readFile(new URL('index.html', root), 'utf8');
const detector = await readFile(new URL('invisible-character-detector/index.html', root), 'utf8');
const utilityCss = await readFile(new URL('utility.css', root), 'utf8');

test('primary navigation keeps its single-row flex layout', () => {
  assert.match(utilityCss, /\.nav-inner\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*space-between;/s);
  assert.match(utilityCss, /@media\s*\(max-width:\s*700px\)[\s\S]*?\.nav-link-secondary\s*\{\s*display:\s*none;/);
  assert.match(homepage, /class="nav-link nav-link-github"[^>]*>GitHub<\/a>/);
  assert.doesNotMatch(homepage, /class="nav-link nav-link-secondary"[^>]*>GitHub<\/a>/);
});

test('Unicode Detector links resolve from both hosted and local-file previews', async () => {
  const expected = 'invisible-character-detector/index.html';
  const hrefs = [...homepage.matchAll(/href="([^"]+)"[^>]*>[^<]*Unicode (?:detector|Detector)/g)].map(match => match[1]);
  assert.ok(hrefs.length >= 2);
  assert.ok(hrefs.every(href => href === expected));
  await access(fileURLToPath(new URL(expected, new URL('index.html', root))));
});

test('detector navigation uses explicit homepage files for local previews', () => {
  assert.match(detector, /href="\.\.\/index\.html"/);
  assert.match(detector, /href="\.\.\/index\.html#tool"/);
  assert.doesNotMatch(detector, /href="\.\.\/"/);
});
