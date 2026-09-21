import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM, VirtualConsole, requestInterceptor } from 'jsdom';
import { TextEncoder, TextDecoder } from 'node:util';

const root = new URL('../', import.meta.url);
const sources = Object.fromEntries(await Promise.all([
  'stegzero-protocol.js', 'unicode-inspector-data.js', 'unicode-inspector.js', 'unicode-inspector-ui.js'
].map(async name => [name, await readFile(new URL(name, root), 'utf8')])));

async function loadPage(t, page = 'index.html') {
  const html = await readFile(new URL(page, root), 'utf8');
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].at(-1)[1];
  const errors = [], copied = [], downloads = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''), {
    url: new URL(page, 'https://stegzero.test/').href, runScripts: 'dangerously', virtualConsole
  });
  const { window } = dom;
  const document = window.document;
  Object.assign(window, { TextEncoder, TextDecoder });
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async value => { copied.push(value); } } });
  window.URL.createObjectURL = value => { downloads.push(value); return 'blob:test'; };
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () {};
  window.HTMLElement.prototype.scrollIntoView = function () {};
  await new Promise(resolve => window.addEventListener('load', resolve, { once: true }));
  for (const [name, source] of Object.entries(sources)) vm.runInContext(source, dom.getInternalVMContext(), { filename: name });
  vm.runInContext(inline, dom.getInternalVMContext(), { filename: page + ':inline' });
  document.dispatchEvent(new window.Event('DOMContentLoaded'));
  t.after(() => { dom.window.close(); assert.deepEqual(errors, [], 'No uncaught DOM errors'); });
  const edit = (id, value) => {
    const input = document.getElementById(id);
    input.value = value;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  return { window, document, edit, copied, downloads };
}

function buttonIn(host, label) {
  const button = [...host.querySelectorAll('button')].find(node => node.textContent === label);
  assert.ok(button, `Button exists: ${label}`);
  return button;
}

const flag = '🏴' + [...'gbeng'].map(c => String.fromCodePoint(0xE0000 + c.codePointAt(0))).join('') + String.fromCodePoint(0xE007F);
const invalidTags = [...'hide'].map(c => String.fromCodePoint(0xE0000 + c.codePointAt(0))).join('');

for (const page of ['index.html', 'invisible-character-detector/index.html']) {
  test(`${page}: recommended cleanup preserves valid emoji and invalidates on edit`, async t => {
    const { window, document, edit, copied } = await loadPage(t, page);
    const home = page === 'index.html';
    if (home) document.getElementById('tab-decode').click();
    const inputId = home ? 'encodedText' : 'unicodeInput';
    const host = document.getElementById(home ? 'revealUnicodeInspector' : 'standaloneUnicodeInspector');
    edit(inputId, flag + ' ' + invalidTags);
    if (home) window.handleDecode();
    else document.getElementById('unicodeInspectNow').click();
    const copy = buttonIn(host, 'Copy cleaned text');
    const reportCopy = buttonIn(host, 'Copy text report');
    assert.equal(copy.disabled, false);
    copy.click();
    assert.equal(copied.at(-1), flag + ' ');
    assert.equal(document.getElementById(inputId).value, flag + ' ' + invalidTags);
    edit(inputId, 'abcd');
    assert.equal(copy.disabled, true, 'Cleanup disabled immediately, before debounce expires');
    assert.equal(reportCopy.disabled, true);
    copy.click();
    assert.equal(copied.length, 1);
    // A stale filter click must neither crash nor cancel the pending inspection.
    const categoryButton = host.querySelector('.uzi-chart-row');
    if (categoryButton) categoryButton.click();
    await new Promise(resolve => window.setTimeout(resolve, 220));
    assert.match(host.querySelector('.uzi-verdict').textContent, /No inspected hidden Unicode/);
    assert.equal(copy.disabled, true);
    assert.equal(reportCopy.disabled, false);
  });
}

test('cleanup and exports reject programmatic input changes without an input event', async t => {
  const { window, document, copied, downloads } = await loadPage(t, 'invisible-character-detector/index.html');
  const input = document.getElementById('unicodeInput');
  const host = document.getElementById('standaloneUnicodeInspector');
  input.value = 'a\u0000bc';
  document.getElementById('unicodeInspectNow').click();
  input.value = 'abcd';
  for (const label of ['Copy cleaned text', 'Download cleaned .txt', 'Copy text report', 'Download JSON report']) buttonIn(host, label).click();
  assert.deepEqual(copied, []);
  assert.deepEqual(downloads, []);
  assert.equal(input.value, 'abcd');
  document.getElementById('unicodeInspectNow').click();
  assert.equal(buttonIn(host, 'Copy cleaned text').disabled, true);
});

test('both modes retain full copy/reveal results when the preview is capped', async t => {
  const { window, document, edit, copied, downloads } = await loadPage(t);
  for (const mode of ['v2', 'binary']) {
    window.setEncodeMode(mode);
    document.getElementById('tab-encode').click();
    edit('visibleText', 'Visible cover');
    const secret = 'Unicode 🔎 '.repeat(300);
    edit('hiddenMessage', secret);
    buttonIn(document.getElementById('panel-encode'), 'Hide message').click();
    const result = document.getElementById('encodedResult').textContent;
    assert.ok(document.getElementById('encodePreview').querySelectorAll('.zw-mark, .zw-mark-bin').length <= 2000);
    assert.match(document.getElementById('encodePreview').textContent, /Preview limited/);
    document.getElementById('encodeCopyBtn').click();
    assert.equal(copied.at(-1), result);
    document.getElementById('encodeExportBtn').click();
    const exported = await new Promise(resolve => {
      const reader = new window.FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsText(downloads.at(-1));
    });
    assert.equal(exported, result);
    document.getElementById('encodeRevealBtn').click();
    await new Promise(resolve => window.setTimeout(resolve, 220));
    assert.equal(document.getElementById('decodedResult').textContent, secret);
    assert.equal(document.getElementById('revealCopyBtn').disabled, false);
  }
});

test('oversized encode and local verification fail gracefully without a downloadable result', async t => {
  const { window, document, edit } = await loadPage(t);
  window.setEncodeMode('binary');
  edit('hiddenMessage', 'a'.repeat(62500));
  buttonIn(document.getElementById('panel-encode'), 'Hide message').click();
  assert.match(document.getElementById('encodeStatus').textContent, /500,000/);
  assert.equal(document.getElementById('encodeCopyBtn').disabled, true);
  assert.equal(document.getElementById('encodeExportBtn').disabled, true);
  window.runRoundTrip();
  assert.match(document.getElementById('rtResult').textContent, /500,000/);
});

test('watermarked HTML and XML remain parseable with unchanged content', async t => {
  const { window } = await loadPage(t);
  const html = '<!doctype html><html><head><script>const answer = 42;</script><style>p { color:red }</style></head><body><p>Hi</p></body></html>';
  const watermarkedHtml = window.wmEncode(html, 'html:42', 'html');
  const original = new window.DOMParser().parseFromString(html, 'text/html');
  const parsed = new window.DOMParser().parseFromString(watermarkedHtml, 'text/html');
  assert.equal(parsed.compatMode, original.compatMode);
  assert.equal(parsed.documentElement.outerHTML, original.documentElement.outerHTML);
  for (const source of ['<?xml version="1.0"?><root><value>42</value></root>', '<!DOCTYPE root><root/>']) {
    const xml = new window.DOMParser().parseFromString(window.wmEncode(source, 'xml:42', 'xml'), 'application/xml');
    assert.equal(xml.querySelector('parsererror'), null);
    assert.equal(xml.documentElement.tagName, 'root');
  }
});

test('file upload, watermark download, and verification work for every supported format', async t => {
  const { window, document, downloads } = await loadPage(t);
  const readBlob = blob => new Promise((resolve, reject) => {
    const reader = new window.FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsText(blob);
  });
  for (const [name, source] of [
    ['sample.txt', 'alpha\nbeta'], ['sample.md', '# Title\nText'],
    ['sample.json', '{"name":"Alice","count":1}'],
    ['sample.csv', '"name","count"\r\n"Alice, A.",42'],
    ['sample.html', '<script>const answer = 42;</script><p>Hi</p>'],
    ['sample.xml', '<?xml version="1.0"?><root/>']
  ]) {
    await window.handleEmbedFile({ files: [new window.File([source], name, { type: 'text/plain' })] });
    document.getElementById('wmIdInput').value = 'file:' + name;
    window.handleEmbed();
    assert.match(document.getElementById('embedStatus').textContent, /Watermarked/);
    const output = await readBlob(downloads.at(-1));
    if (name.endsWith('.json')) assert.deepEqual(JSON.parse(output), JSON.parse(source));
    await window.handleVerifyFile({ files: [new window.File([output], name)] });
    window.handleVerify();
    assert.match(document.getElementById('verifyResultCard').textContent, /Watermark found/);
    assert.ok(document.getElementById('verifyResultCard').textContent.includes('file:' + name));
  }
});

test('actual script tags load the shared engine and lazily initialize Reveal', async t => {
  const requested = [], errors = [];
  const scriptsOnly = requestInterceptor(request => {
    const name = new URL(request.url).pathname.slice(1);
    if (!Object.hasOwn(sources, name)) return new Response('', { headers: { 'Content-Type': 'text/css' } });
    requested.push(name);
    return new Response(sources[name], { headers: { 'Content-Type': 'application/javascript' } });
  });
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(await readFile(new URL('index.html', root), 'utf8'), {
    url: 'https://stegzero.test/', runScripts: 'dangerously', resources: { interceptors: [scriptsOnly] }, virtualConsole,
    beforeParse(window) {
      Object.assign(window, { TextEncoder, TextDecoder });
      window.HTMLElement.prototype.scrollIntoView = function () {};
    }
  });
  t.after(() => { dom.window.close(); assert.deepEqual(errors, []); });
  const { window } = dom, document = window.document;
  await new Promise(resolve => window.addEventListener('load', resolve, { once: true }));
  assert.deepEqual(requested, ['stegzero-protocol.js']);
  document.getElementById('visibleText').value = 'Cover';
  document.getElementById('hiddenMessage').value = 'Lazy-loaded secret 🔎';
  buttonIn(document.getElementById('panel-encode'), 'Hide message').click();
  document.getElementById('encodeRevealBtn').click();
  await window.ensureUnicodeInspector();
  window.handleDecode();
  assert.equal(document.getElementById('decodedResult').textContent, 'Lazy-loaded secret 🔎');
  assert.deepEqual(requested, ['stegzero-protocol.js', 'unicode-inspector-data.js', 'unicode-inspector.js', 'unicode-inspector-ui.js']);
});

test('the next action follows the result state and returns to Hide message after edits', async t => {
  const { window, document, edit } = await loadPage(t);
  const submit = document.getElementById('encodeSubmitBtn');
  const copy = document.getElementById('encodeCopyBtn');
  const primary = () => [...document.querySelectorAll('#panel-encode .btn-primary')];
  assert.deepEqual(primary(), [submit]);
  edit('hiddenMessage', 'A message');
  submit.click();
  assert.deepEqual(primary(), [copy]);
  assert.equal(copy.disabled, false);
  edit('visibleText', 'New cover');
  assert.deepEqual(primary(), [submit]);
  assert.equal(copy.disabled, true);
  submit.click();
  window.setEncodeMode('binary');
  assert.deepEqual(primary(), [submit]);
  assert.equal(copy.disabled, true);
  submit.click();
  window.clearEncode();
  assert.deepEqual(primary(), [submit]);
  assert.equal(copy.disabled, true);
});

test('multiline messages preserve newlines, Unicode, and copy content in both modes', async t => {
  const { window, document, edit, copied } = await loadPage(t);
  const message = 'First line 🔎\n\nSecond line\twith a tab\n';
  assert.equal(document.getElementById('hiddenMessage').tagName, 'TEXTAREA');
  for (const mode of ['v2', 'binary']) {
    document.getElementById('tab-encode').click();
    window.setEncodeMode(mode);
    edit('hiddenMessage', message);
    assert.equal(document.getElementById('msgCounter').textContent, `${Array.from(message).length} chars`);
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    document.getElementById('encodeRevealBtn').click();
    await new Promise(resolve => window.setTimeout(resolve, 220));
    assert.equal(document.getElementById('decodedResult').textContent, message);
    document.getElementById('revealCopyBtn').click();
    assert.equal(copied.at(-1), message);
  }
});

test('Reveal reports checking before a protected result and never announces unverified success', async t => {
  const { window, document, edit } = await loadPage(t);
  edit('hiddenMessage', 'Protected\nmessage');
  document.getElementById('passphraseToggle').click();
  edit('passphraseInput', 'correct passphrase');
  document.getElementById('encodeSubmitBtn').click();
  document.getElementById('encodeRevealBtn').click();
  assert.equal(document.getElementById('revealResultHeading').textContent, 'Checking message…');
  assert.equal(document.getElementById('revealResultCard').getAttribute('aria-busy'), 'true');
  assert.equal(document.getElementById('revealCopyBtn').disabled, true);
  assert.equal(document.getElementById('toast').textContent, '');
  await new Promise(resolve => window.setTimeout(resolve, 220));
  assert.equal(document.getElementById('revealResultHeading').textContent, 'Passphrase required');
  assert.equal(document.getElementById('revealResultCard').getAttribute('aria-busy'), 'false');
  document.getElementById('decodePassToggle').click();
  edit('decodePassInput', 'incorrect');
  assert.equal(document.getElementById('revealResultHeading').textContent, 'Passphrase not verified');
  edit('decodePassInput', 'correct passphrase');
  assert.equal(document.getElementById('decodedResult').textContent, 'Protected\nmessage');
  assert.equal(document.getElementById('decodeStatus').textContent, 'Hidden message revealed and verified.');
  assert.equal(document.getElementById('toast').textContent, '');
  assert.equal(document.querySelector('#revealUnicodeInspector .uzi-live').textContent, '');
  assert.equal(document.getElementById('decodedResult').hasAttribute('aria-live'), false);
  edit('encodedText', 'New ordinary text');
  assert.equal(document.getElementById('revealCopyBtn').disabled, true);
  assert.equal(document.getElementById('revealExportBtn').disabled, true);
  assert.equal(document.getElementById('decodedResult').textContent, 'Checking the current text…');
  window.clearDecode();
  await new Promise(resolve => window.setTimeout(resolve, 220));
  assert.equal(document.getElementById('decodedResult').textContent, 'Paste text above to begin.');
  assert.equal(document.getElementById('revealResultCard').getAttribute('aria-busy'), 'false');
});

test('detector options and diagnostics start collapsed and remain fully usable', async t => {
  const { window, document, edit } = await loadPage(t, 'invisible-character-detector/index.html');
  const options = document.querySelector('.inspection-options');
  assert.equal(options.open, false);
  for (const id of ['unicodeContext', 'unicodeAdvanced', 'unicodeFile', 'unicodeDropZone']) {
    assert.ok(options.contains(document.getElementById(id)));
  }
  options.open = true;
  document.getElementById('unicodeContext').value = 'source';
  edit('unicodeInput', 'a\u202Eb');
  document.getElementById('unicodeInspectNow').click();
  const diagnostic = document.querySelector('.uzi-diagnostic');
  assert.equal(diagnostic.tagName, 'DETAILS');
  assert.equal(diagnostic.open, false);
  diagnostic.open = true;
  assert.match(diagnostic.querySelector('pre').textContent, /\[RLO\]/);
  assert.equal(document.getElementById('unicodeInput').value, 'a\u202Eb');
  assert.match(document.querySelector('.uzi-live').textContent, /Inspection complete: 1 finding/);
  assert.equal(buttonIn(document.getElementById('standaloneUnicodeInspector'), 'Copy text report').disabled, false);
});
