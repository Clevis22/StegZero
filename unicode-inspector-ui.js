(function (root) {
  'use strict';

  const PAGE_SIZE = 200;
  const MAX_FILE_BYTES = 1024 * 1024;
  const SOURCE_EXTENSIONS = new Set([
    'c','cc','cpp','cs','css','go','h','hpp','html','htm','ini','java','js','jsx','json','log','lua',
    'md','mjs','php','pl','properties','py','rb','rs','sh','sql','svg','toml','ts','tsx','txt','xml','yaml','yml'
  ]);
  const CATEGORY_LABELS = {
    'bidi-control': 'Bidirectional controls', 'unicode-tag': 'Unicode Tags',
    'variation-selector': 'Variation selectors', 'join-control': 'Join controls',
    'line-word-format': 'Line, word & grapheme formatting', 'invisible-math': 'Invisible math operators',
    'control-code': 'Control codes', 'unusual-whitespace': 'Unusual whitespace',
    'blank-filler': 'Blank & filler characters', 'deprecated-format': 'Deprecated format controls',
    'other-default-ignorable': 'Other default-ignorables', 'private-use': 'Private-use characters',
    'noncharacter': 'Noncharacters', 'unassigned': 'Unassigned code points',
    'orphan-combining-mark': 'Orphan combining marks'
  };
  const FORMAT_LABELS = { v2: 'Standard', binary: 'Compatibility', legacy: 'Legacy' };

  function el(tag, className, textValue) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (textValue !== undefined) node.textContent = textValue;
    return node;
  }

  function button(label, className, handler) {
    const node = el('button', className || 'ui-button', label);
    node.type = 'button';
    node.addEventListener('click', handler);
    return node;
  }

  function download(name, value, type) {
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(new Blob([value], { type: type || 'text/plain;charset=utf-8' }));
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 0);
  }

  async function copy(value) {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('Clipboard access is unavailable.');
    await navigator.clipboard.writeText(value);
  }

  function flashButton(node, label) {
    if (!node.dataset.label) node.dataset.label = node.textContent;
    node.textContent = label;
    clearTimeout(node._flash);
    node._flash = setTimeout(() => { node.textContent = node.dataset.label; }, 1500);
  }

  function decodeLocalFile(buffer) {
    const bytes = new Uint8Array(buffer);
    let encoding = 'utf-8', offset = 0;
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) offset = 3;
    else if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) { encoding = 'utf-16le'; offset = 2; }
    else if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) { encoding = 'utf-16be'; offset = 2; }
    const sample = bytes.slice(offset, Math.min(bytes.length, offset + 4096));
    if (encoding === 'utf-8' && sample.some((value, index) => value === 0 && index < 512)) {
      throw new Error('This file appears to be binary or lacks a supported UTF-16 byte-order mark.');
    }
    try { return new TextDecoder(encoding, { fatal: true }).decode(bytes.slice(offset)); }
    catch (_) { throw new Error('The file is not valid UTF-8, UTF-16LE, or UTF-16BE text.'); }
  }

  function assessmentLabel(value) {
    return value ? value.charAt(0).toUpperCase() + value.slice(1) : 'None';
  }


  const RANK = { expected: 0, review: 1, suspicious: 2 };
  const MARKED_LIMIT = 20000;
  const STEGZERO_CARRIERS = new Set(['\u200B', '\u200C', '\u200D', '\u2060', '\u2062', '\u2063', '\u2064', '\uFEFF']);
  const PAYLOAD_LABELS = { 'unicode-tags-ascii': 'Unicode Tag text', 'variation-selector-bytes': 'Variation-selector bytes' };
  const PRESET_DESCRIPTIONS = {
    conservative: 'Removes only broken or pointless characters. Emoji, multilingual text, spaces and bidi controls are kept.',
    security: 'Also removes bidi controls, payload-like characters and confirmed StegZero carriers. Joiners and unusual spaces are kept.',
    custom: 'Removes only the character types you choose below.',
    aggressive: 'Removes every hidden character and turns unusual spaces into ordinary ones.'
  };

  function plural(count, one, many) { return `${count.toLocaleString()} ${count === 1 ? one : (many || one + 's')}`; }
  function chipText(token) { return token.replace(/^\[|\]$/g, ''); }
  function highestOf(findings) {
    return findings.reduce((best, f) => RANK[f.assessment] > RANK[best] ? f.assessment : best, 'expected');
  }
  function truncate(value, max) { return value.length > max ? value.slice(0, max - 1) + '…' : value; }

  function mount(options) {
    options = options || {};
    const scanner = root.StegZeroUnicode;
    if (!scanner) throw new Error('StegZeroUnicode must load before the inspector UI.');
    const host = typeof options.root === 'string' ? document.querySelector(options.root) : options.root;
    const input = typeof options.input === 'string' ? document.querySelector(options.input) : options.input;
    if (!host || !input) throw new Error('Inspector root and input are required.');

    const pageSize = Math.max(1, Number(options.pageSize) || PAGE_SIZE);
    const state = { report: null, sourceText: null, timer: null, generation: 0, visible: pageSize, category: 'all', fileName: null, groups: new Map(), presetChosen: false };
    host.classList.add('uzi');
    host.textContent = '';

    const live = el('p', 'uzi-live sr-only');
    live.setAttribute('aria-live', 'polite');
    const error = el('div', 'uzi-notice uzi-notice-error');
    error.hidden = true;

    // Verdict: the answer first, with any decoded payload right underneath.
    const verdict = el('section', 'uzi-verdict');
    const verdictTitle = el('h3', 'uzi-verdict-title', 'No current inspection');
    const verdictDetail = el('p', 'uzi-verdict-detail');
    const verdictCounts = el('p', 'uzi-verdict-counts');
    const payloads = el('div', 'uzi-payloads');
    verdict.append(verdictTitle, verdictDetail, verdictCounts, payloads);
    // Hosts with their own result card (the Reveal panel) already state the verdict.
    if (options.compact) verdict.hidden = true;

    const markedSection = el('section', 'uzi-section');
    markedSection.append(el('h3', 'uzi-heading', 'Your text with hidden characters marked'));
    const marked = el('div', 'uzi-marked');
    marked.dir = 'ltr';
    const markedNote = el('p', 'uzi-help');
    markedSection.append(marked, markedNote);

    const findingsSection = el('section', 'uzi-section');
    findingsSection.append(el('h3', 'uzi-heading', 'What was found'));
    const filters = el('div', 'uzi-filters');
    filters.setAttribute('role', 'group');
    filters.setAttribute('aria-label', 'Filter findings by type');
    const rows = el('div', 'uzi-groups');
    const more = button('Show more', 'uzi-button uzi-button-secondary uzi-more', () => { state.visible += pageSize; renderRows(); });
    findingsSection.append(filters, rows, more);

    const cleanupSection = el('section', 'uzi-section');
    cleanupSection.append(el('h3', 'uzi-heading', 'Remove hidden characters'));
    const cleanupHelp = el('p', 'uzi-help', 'Creates a cleaned copy. The text you pasted is not changed.');
    const cleanupControls = el('div', 'uzi-cleanup-controls');
    const presetLabel = el('label', 'uzi-control');
    presetLabel.append(el('span', '', 'What to remove'));
    const preset = el('select', 'uzi-select');
    [['conservative', 'Recommended'], ['security', 'Security-focused'], ['custom', 'Custom'], ['aggressive', 'Everything (may alter text)']].forEach(([value, label]) => {
      const option = el('option', '', label); option.value = value; preset.append(option);
    });
    presetLabel.append(preset);
    const removeCarrierLabel = el('label', 'uzi-check');
    const removeCarrier = document.createElement('input'); removeCarrier.type = 'checkbox';
    removeCarrierLabel.append(removeCarrier, el('span', '', 'Also remove StegZero carrier characters'));
    removeCarrierLabel.hidden = true;
    cleanupControls.append(presetLabel, removeCarrierLabel);
    const cleanupDescription = el('p', 'uzi-help uzi-cleanup-description');
    const aggressiveWarning = el('p', 'uzi-warning', 'This can change how emoji, non-Latin scripts, line breaks and maths render. Check the preview before using the copy.');
    aggressiveWarning.hidden = true;
    const cleanupAdvanced = el('details', 'uzi-cleanup-advanced');
    const cleanupAdvancedSummary = el('summary', '', 'Choose character types');
    const categoryChecks = el('fieldset', 'uzi-category-checks');
    const legend = el('legend', 'sr-only', 'Character types to remove');
    categoryChecks.append(legend);
    cleanupAdvanced.append(cleanupAdvancedSummary, categoryChecks);
    const cleanupMeta = el('p', 'uzi-cleanup-meta');
    const cleanupPreview = el('div', 'uzi-marked uzi-marked-diff');
    cleanupPreview.dir = 'ltr';
    cleanupPreview.hidden = true;
    const cleanupActions = el('div', 'uzi-actions');
    const copyClean = button('Copy cleaned text', 'uzi-button', () => applyCleanup('copy'));
    const downloadClean = button('Download cleaned .txt', 'uzi-button uzi-button-secondary', () => applyCleanup('download'));
    cleanupActions.append(copyClean, downloadClean);
    cleanupSection.append(cleanupHelp, cleanupControls, cleanupDescription, aggressiveWarning, cleanupAdvanced, cleanupMeta, cleanupPreview, cleanupActions);

    // Specialist detail and exports stay available without crowding the result.
    const technical = el('details', 'uzi-section uzi-diagnostic');
    technical.append(el('summary', 'uzi-heading', 'Technical details and reports'));
    const technicalBody = el('div', 'uzi-diagnostic-body');
    const escapedHelp = el('p', 'uzi-help', 'Escaped text in logical order. Raw bidi controls are never rendered here.');
    const escaped = el('pre', 'uzi-escaped');
    escaped.dir = 'ltr';
    const technicalSummary = el('dl', 'uzi-stats');
    const reportActions = el('div', 'uzi-actions');
    const copyTextReport = button('Copy text report', 'uzi-button uzi-button-secondary', () => copyReport('text'));
    const downloadJson = button('Download JSON report', 'uzi-button uzi-button-secondary', () => downloadReport());
    reportActions.append(copyTextReport, downloadJson);
    technicalBody.append(escapedHelp, escaped, technicalSummary, el('p', 'uzi-help', 'Reports list every finding, including ones not expanded above.'), reportActions);
    technical.append(technicalBody);

    host.append(live, error, verdict, markedSection, findingsSection, cleanupSection, technical);

    function currentContext() {
      return options.contextSelect ? options.contextSelect.value : (options.context || 'plain');
    }
    function advancedEnabled() { return !!(options.advancedToggle && options.advancedToggle.checked); }
    function announce(message, isError) {
      live.textContent = message;
      error.hidden = !isError;
      error.textContent = isError ? message : '';
      if (typeof options.onNotice === 'function') options.onNotice(message, !!isError);
    }
    function protocolOverlay(text) {
      try { return typeof options.getStegZero === 'function' ? options.getStegZero(text) : null; }
      catch (_) { return null; }
    }

    function inspectNow() {
      const generation = ++state.generation;
      clearTimeout(state.timer);
      try {
        const report = scanner.inspect(input.value, {
          context: currentContext(), includeAdvanced: advancedEnabled(), stegzero: protocolOverlay(input.value)
        });
        if (generation !== state.generation) return null;
        render(report);
        if (options.announceInspection !== false) announce(`Inspection complete: ${plural(report.summary.findingCount, 'finding')}.`, false);
        return report;
      } catch (scanError) {
        if (generation !== state.generation) return null;
        state.report = null;
        announce(scanError.message || 'Inspection failed.', true);
        renderEmpty();
        return null;
      }
    }

    function schedule() {
      invalidate();
      const generation = state.generation;
      state.timer = setTimeout(() => {
        if (generation !== state.generation) return;
        inspectNow();
      }, 180);
    }

    function render(report) {
      state.report = report;
      state.sourceText = input.value;
      state.visible = pageSize;
      state.category = 'all';
      state.groups = buildGroups(report);
      // Suspicious characters usually need more than the low-impact preset removes.
      if (!state.presetChosen) preset.value = report.findings.some(f => f.assessment === 'suspicious') ? 'security' : 'conservative';
      copyTextReport.disabled = false;
      downloadJson.disabled = false;
      const hasFindings = report.summary.findingCount > 0;
      markedSection.hidden = !hasFindings;
      findingsSection.hidden = !hasFindings;
      cleanupSection.hidden = !hasFindings;
      renderVerdict();
      renderMarked();
      renderFilters();
      renderRows();
      renderCleanupChecks();
      renderCleanup();
      renderTechnical();
      host.hidden = false;
    }

    function renderEmpty() {
      invalidate();
      verdictTitle.textContent = 'No current inspection';
      verdictDetail.textContent = '';
      verdictCounts.textContent = '';
      verdict.dataset.assessment = 'none';
      payloads.textContent = '';
      marked.textContent = '';
      filters.textContent = '';
      rows.textContent = '';
      categoryChecks.replaceChildren(legend);
      cleanupAdvanced.hidden = true;
      cleanupMeta.textContent = '';
      cleanupPreview.hidden = true;
      cleanupPreview.textContent = '';
      escaped.textContent = '';
      technicalSummary.textContent = '';
      markedSection.hidden = true;
      findingsSection.hidden = true;
      cleanupSection.hidden = true;
      more.hidden = true;
    }

    function invalidate() {
      clearTimeout(state.timer);
      state.generation++;
      state.report = null;
      state.sourceText = null;
      copyClean.disabled = true;
      downloadClean.disabled = true;
      copyTextReport.disabled = true;
      downloadJson.disabled = true;
      payloads.querySelectorAll('button').forEach(node => { node.disabled = true; });
      verdictTitle.textContent = 'Checking the current text…';
      cleanupMeta.textContent = 'Inspect the current text before creating a cleaned copy.';
    }

    function hasCurrentReport() {
      return !!state.report && state.sourceText === input.value;
    }

    // Findings in a decoded payload are one group; everything else groups by code point.
    function buildGroups(report) {
      const groups = new Map(), byFinding = new Map();
      report.candidates.forEach((candidate, index) => {
        const ids = new Set(candidate.findingIds);
        const findings = report.findings.filter(f => ids.has(f.id));
        if (!findings.length) return;
        const key = 'payload:' + index;
        groups.set(key, { key, candidate, finding: findings[0], findings, category: findings[0].category });
        findings.forEach(f => byFinding.set(f.id, key));
      });
      report.findings.forEach(f => {
        if (byFinding.has(f.id)) return;
        const key = `${f.category}|${f.codePoint}`;
        if (!groups.has(key)) groups.set(key, { key, candidate: null, finding: f, findings: [], category: f.category });
        groups.get(key).findings.push(f);
        byFinding.set(f.id, key);
      });
      groups.forEach(group => { group.assessment = highestOf(group.findings); });
      groups.byFinding = byFinding;
      return groups;
    }

    function payloadLabel(candidate) {
      return candidate.decodedText !== null ? `“${truncate(candidate.decodedText.trim(), 32)}”` : `${candidate.escapedBytes.split(' ').length} bytes`;
    }

    function renderVerdict() {
      const report = state.report;
      const count = report.summary.findingCount;
      const counts = { suspicious: 0, review: 0, expected: 0 };
      report.findings.forEach(f => { counts[f.assessment]++; });
      const status = report.stegzero.status;
      let title, detail, assessment = report.summary.highestAssessment || 'none';
      if (status === 'decoded') {
        title = 'Hidden StegZero message found';
        detail = 'This text carries a StegZero message.';
      } else if (status === 'passphrase-required') {
        title = 'StegZero message found — passphrase needed';
        detail = 'Enter the passphrase to read it.';
      } else if (status === 'possible') {
        title = 'Possible StegZero message';
        detail = 'The characters look like a StegZero message, but it could not be verified.';
      } else if (report.candidates.some(c => c.codec === 'unicode-tags-ascii')) {
        title = 'Hidden text found';
        detail = 'It is written in invisible Unicode Tag characters, a common way to smuggle instructions to AI models.';
        assessment = 'suspicious';
      } else if (report.candidates.length) {
        title = 'Possible hidden data found';
        detail = 'Variation selectors are arranged like encoded bytes. This is a common convention, not a Unicode standard.';
      } else if (!count) {
        title = 'No hidden characters found';
        detail = 'Nothing invisible or unusual was detected in this text.';
      } else if (counts.suspicious) {
        title = 'Suspicious hidden characters found';
        detail = 'Some characters are rarely legitimate here. Check them below before trusting this text.';
      } else if (counts.review) {
        title = 'Hidden characters found';
        detail = 'They have legitimate uses, but are worth checking.';
      } else {
        title = 'Only normal formatting characters';
        detail = 'These are expected in emoji and some writing systems.';
      }
      verdictTitle.textContent = title;
      verdictDetail.textContent = detail;
      verdict.dataset.assessment = assessment;
      const parts = [];
      if (counts.suspicious) parts.push(`${counts.suspicious.toLocaleString()} suspicious`);
      if (counts.review) parts.push(`${counts.review.toLocaleString()} to review`);
      if (counts.expected) parts.push(`${counts.expected.toLocaleString()} expected`);
      verdictCounts.textContent = count ? `${plural(count, 'hidden character')} · ${parts.join(' · ')}` : '';
      payloads.textContent = '';
      report.candidates.forEach(candidate => {
        const card = el('div', 'uzi-payload');
        card.append(el('p', 'uzi-payload-label', candidate.decodedText !== null ? `Decoded ${PAYLOAD_LABELS[candidate.codec] || 'payload'}` : `${PAYLOAD_LABELS[candidate.codec] || 'Payload'} (could not be read as text)`));
        const value = el('pre', 'uzi-payload-value');
        if (candidate.decodedText !== null) {
          value.textContent = scanner.escapedView(candidate.decodedText, scanner.inspect(candidate.decodedText, { context: 'plain', includeAdvanced: true }));
        } else value.textContent = candidate.escapedBytes;
        const actions = el('div', 'uzi-actions');
        if (candidate.decodedText !== null) actions.append(copyButton('Copy decoded text', () => candidate.decodedText));
        actions.append(copyButton('Copy escaped bytes', () => candidate.escapedBytes));
        card.append(value, actions);
        payloads.append(card);
      });
    }

    function copyButton(label, value) {
      const node = button(label, 'uzi-button uzi-button-secondary', () => {
        if (!hasCurrentReport()) return;
        copy(value()).then(() => flashButton(node, 'Copied ✓')).catch(e => announce(e.message, true));
      });
      return node;
    }

    // Render text with hidden characters as visible chips. Adjacent findings that share
    // a state collapse into one chip so payloads and long carrier runs stay readable.
    function renderMarkedText(target, text, report, stateFor, onChip) {
      target.textContent = '';
      const byOffset = new Map(report.findings.map(f => [f.utf16Offset, f]));
      let buffer = '', run = null, offset = 0, seen = 0, truncated = false;
      const flushText = () => { if (buffer) { target.append(document.createTextNode(buffer)); buffer = ''; } };
      const flushRun = () => {
        if (!run) return;
        const group = state.groups.get(run.groupKey);
        const candidate = group && group.candidate && run.findings.every(f => state.groups.byFinding.get(f.id) === run.groupKey) ? group.candidate : null;
        let label;
        if (candidate) label = `${candidate.codec === 'unicode-tags-ascii' ? 'TAG' : 'VS'} ${payloadLabel(candidate)}`;
        else if (run.state.carrier) label = '';
        else if (run.findings.length <= 2) label = run.findings.map(f => chipText(f.token)).join(' ');
        else label = `${run.findings.length.toLocaleString()} hidden`;
        if (run.state.replacement !== undefined) label += ` → ${run.state.replacement}`;
        const chip = el(onChip ? 'button' : 'span', `uzi-chip is-${run.state.kind}${run.state.carrier ? ' uzi-chip-dot' : ''}`, label);
        const groupKey = run.groupKey;
        if (onChip) { chip.type = 'button'; chip.addEventListener('click', () => onChip(groupKey)); }
        const names = Array.from(new Set(run.findings.map(f => f.name)));
        chip.title = `${run.state.carrier ? 'StegZero carriers: ' : ''}${names.slice(0, 6).join(', ')}${names.length > 6 ? '…' : ''} (${plural(run.findings.length, 'character')})`;
        if (!label) chip.setAttribute('aria-label', chip.title);
        target.append(chip);
        run = null;
      };
      for (const value of text) {
        if (++seen > MARKED_LIMIT) { truncated = true; break; }
        const finding = byOffset.get(offset);
        offset += value.length;
        if (!finding) {
          if (run) flushRun();
          buffer += value;
          continue;
        }
        const itemState = stateFor(finding);
        const groupKey = state.groups.byFinding.get(finding.id);
        const isPayload = groupKey.startsWith('payload:');
        const runKey = itemState.key + (isPayload ? groupKey : '');
        if (run && run.key === runKey) {
          run.findings.push(finding);
          if (RANK[itemState.kind] > RANK[run.state.kind]) run.state = itemState;
        } else {
          flushRun(); flushText();
          run = { key: runKey, state: itemState, groupKey, findings: [finding] };
        }
      }
      flushRun(); flushText();
      return truncated;
    }

    function renderMarked() {
      const carriers = state.report.stegzero && state.report.stegzero.format ? STEGZERO_CARRIERS : null;
      const truncated = renderMarkedText(marked, input.value, state.report, f => carriers && carriers.has(f.value)
        ? { key: 'carrier', kind: f.assessment, carrier: true }
        : { key: 'hidden', kind: f.assessment }, openGroup);
      markedNote.textContent = truncated
        ? `Showing the first ${MARKED_LIMIT.toLocaleString()} characters. Every character is still inspected.`
        : 'Select a marker to see what it is.';
    }

    function renderFilters() {
      filters.textContent = '';
      const counts = state.report.summary.categories;
      const categories = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || (CATEGORY_LABELS[a] || a).localeCompare(CATEGORY_LABELS[b] || b));
      filters.hidden = categories.length < 2;
      const add = (category, label, count) => {
        const chip = button('', 'uzi-filter', () => selectCategory(state.category === category ? 'all' : category));
        chip.dataset.category = category;
        chip.setAttribute('aria-pressed', String(state.category === category));
        chip.append(el('span', '', label), el('span', 'uzi-filter-count', count.toLocaleString()));
        filters.append(chip);
      };
      add('all', 'All', state.report.summary.findingCount);
      categories.forEach(category => add(category, CATEGORY_LABELS[category] || category, counts[category]));
    }

    function selectCategory(category) {
      if (!hasCurrentReport()) return;
      state.category = category; state.visible = pageSize;
      filters.querySelectorAll('button').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.category === category)));
      renderRows();
    }

    function openGroup(key) {
      if (!hasCurrentReport()) return;
      const group = state.groups.get(key);
      if (!group) return;
      if (state.category !== 'all' && state.category !== group.category) selectCategory('all');
      const find = () => Array.from(rows.children).find(node => node.dataset.group === key);
      let node = find();
      while (!node && !more.hidden) { state.visible += pageSize; renderRows(); node = find(); }
      if (!node) return;
      node.open = true;
      node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      node.querySelector('summary').focus({ preventScroll: true });
    }

    function renderRows() {
      if (!hasCurrentReport()) return;
      rows.textContent = '';
      const grouped = Array.from(state.groups.values())
        .filter(group => state.category === 'all' || group.category === state.category)
        .sort((a, b) => RANK[b.assessment] - RANK[a.assessment] || b.findings.length - a.findings.length || a.finding.codePoint.localeCompare(b.finding.codePoint));
      grouped.slice(0, state.visible).forEach(group => rows.append(renderGroup(group)));
      more.hidden = grouped.length <= state.visible;
      if (!more.hidden) more.textContent = `Show ${Math.min(pageSize, grouped.length - state.visible).toLocaleString()} more (${(grouped.length - state.visible).toLocaleString()} remaining)`;
    }

    function renderGroup(group) {
      const finding = group.finding;
      const details = el('details', 'uzi-group');
      details.dataset.group = group.key;
      const head = el('summary');
      const identity = el('span', 'uzi-group-identity');
      if (group.candidate) {
        head.append(el('code', 'uzi-token', group.candidate.codec === 'unicode-tags-ascii' ? 'TAG' : 'VS'));
        identity.append(el('span', 'uzi-group-name', group.candidate.decodedText !== null ? `Hidden text ${payloadLabel(group.candidate)}` : 'Hidden byte payload'),
          el('span', 'uzi-group-meta', `${PAYLOAD_LABELS[group.candidate.codec] || group.candidate.codec} · ${plural(group.findings.length, 'character')}`));
      } else {
        head.append(el('code', 'uzi-token', chipText(finding.token)));
        identity.append(el('span', 'uzi-group-name', finding.name), el('span', 'uzi-group-meta', `${finding.codePoint} · ${CATEGORY_LABELS[finding.category] || finding.category}`));
      }
      const count = el('span', 'uzi-group-count', group.candidate ? '' : `×${group.findings.length.toLocaleString()}`);
      head.append(identity, count, el('span', `uzi-assessment is-${group.assessment}`, assessmentLabel(group.assessment)));
      const body = el('div', 'uzi-group-body');
      details.append(head, body);
      details.addEventListener('toggle', () => {
        if (details.open && !details.dataset.rendered) { details.dataset.rendered = 'true'; renderGroupBody(group, body); }
      });
      return details;
    }

    function renderGroupBody(group, body) {
      if (!hasCurrentReport()) return;
      if (group.candidate) {
        const first = group.findings[0], last = group.findings[group.findings.length - 1];
        body.append(el('p', '', group.candidate.codec === 'unicode-tags-ascii'
          ? 'Unicode Tag characters mirror ASCII but are invisible. Many AI models still read them as text.'
          : 'Variation selectors arranged like bytes. This is a possible payload, not a definitive attribution.'));
        body.append(el('p', 'uzi-help', `Line ${first.line}, column ${first.column}${last !== first ? ` to line ${last.line}, column ${last.column}` : ''}. Checks passed: ${group.candidate.validation.join('; ')}.`));
        const bytes = el('pre', 'uzi-context'); bytes.textContent = group.candidate.escapedBytes;
        body.append(bytes);
        return;
      }
      const reasons = Array.from(new Set(group.findings.map(f => f.reason)));
      reasons.forEach(reason => body.append(el('p', '', reason)));
      const removes = group.findings.filter(f => f.cleanupDefault === 'remove').length;
      body.append(el('p', 'uzi-help', removes === group.findings.length ? 'Recommended cleanup removes these.' : removes ? `Recommended cleanup removes ${removes.toLocaleString()} of these.` : 'Recommended cleanup keeps these.'));
      const list = el('ol', 'uzi-occurrences');
      body.append(list);
      let visible = 20;
      const moreOccurrences = button('', 'uzi-button uzi-button-secondary uzi-more', () => { visible += 20; renderList(); });
      body.append(moreOccurrences);
      const renderList = () => {
        if (!hasCurrentReport()) return;
        list.textContent = '';
        group.findings.slice(0, visible).forEach(f => {
          const item = el('li');
          item.append(el('span', 'uzi-occurrence-position', `Line ${f.line}, col ${f.column}`));
          const context = el('code', 'uzi-context-inline'); context.textContent = scanner.contextFor(input.value, f, 16);
          item.append(context);
          if (f.assessment !== group.assessment) item.append(el('span', `uzi-assessment is-${f.assessment}`, assessmentLabel(f.assessment)));
          list.append(item);
        });
        const remaining = group.findings.length - visible;
        moreOccurrences.hidden = remaining <= 0;
        moreOccurrences.textContent = `Show ${Math.min(20, remaining).toLocaleString()} more (${remaining.toLocaleString()} remaining)`;
      };
      renderList();
    }

    function renderCleanupChecks() {
      categoryChecks.replaceChildren(legend);
      Object.keys(state.report.summary.categories).sort().forEach(category => {
        const label = el('label', 'uzi-check');
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = category;
        checkbox.addEventListener('change', renderCleanup);
        label.append(checkbox, el('span', '', `${CATEGORY_LABELS[category] || category} (${state.report.summary.categories[category]})`));
        categoryChecks.append(label);
      });
      cleanupAdvanced.hidden = !Object.keys(state.report.summary.categories).length;
    }

    function cleanupPolicy() {
      return {
        preset: preset.value,
        selectedCategories: Array.from(categoryChecks.querySelectorAll('input:checked')).map(node => node.value),
        removeStegZero: removeCarrier.checked
      };
    }

    function cleaned() { return scanner.clean(input.value, state.report, cleanupPolicy()); }

    function renderCleanup() {
      if (!hasCurrentReport()) return;
      cleanupDescription.textContent = PRESET_DESCRIPTIONS[preset.value];
      aggressiveWarning.hidden = preset.value !== 'aggressive';
      cleanupAdvancedSummary.textContent = preset.value === 'custom' ? 'Choose character types' : 'Also remove other character types';
      if (preset.value === 'custom') cleanupAdvanced.open = true;
      const hasStegZero = !!(state.report.stegzero && state.report.stegzero.format && state.report.stegzero.status !== 'none');
      removeCarrierLabel.hidden = !hasStegZero;
      if (!hasStegZero) removeCarrier.checked = false;
      const result = cleaned();
      if (!result.changes) {
        cleanupMeta.textContent = `${preset.options[preset.selectedIndex].text.replace(/\s*\(.+\)$/, '')} cleanup would not change this text.`;
      } else {
        const removed = new Map(), replaced = new Map();
        result.changeDetails.forEach(detail => {
          const label = CATEGORY_LABELS[detail.category] || (detail.category === 'stegzero-carrier' ? 'StegZero carriers' : detail.category);
          const target = detail.action === 'replace' ? replaced : removed;
          target.set(label, (target.get(label) || 0) + detail.count);
        });
        const describe = map => Array.from(map, ([label, count]) => `${label} (${count.toLocaleString()})`).join(', ');
        const sentences = [];
        if (removed.size) sentences.push(`Removes ${describe(removed)}.`);
        if (replaced.size) sentences.push(`Replaces ${describe(replaced)} with ordinary spaces or line breaks.`);
        const preserved = Math.max(0, state.report.findings.length - new Set(result.changedFindingIds).size);
        if (preserved) sentences.push(`Keeps ${plural(preserved, 'other character')}.`);
        cleanupMeta.textContent = sentences.join(' ');
      }
      renderCleanupPreview(result);
      copyClean.disabled = result.changes === 0;
      downloadClean.disabled = result.changes === 0;
      const disabledTitle = result.changes === 0 ? 'The selected cleanup makes no changes.' : '';
      copyClean.title = disabledTitle;
      downloadClean.title = disabledTitle;
    }

    function replacementLabel(value) { return value === '\n' ? '⏎' : value === ' ' ? '␠' : value; }

    function renderCleanupPreview(result) {
      cleanupPreview.hidden = result.changes === 0;
      if (!result.changes) { cleanupPreview.textContent = ''; return; }
      const actions = new Map();
      result.changeDetails.forEach(detail => detail.findingIds.forEach(id => actions.set(id, detail)));
      const carriers = state.report.stegzero && state.report.stegzero.format ? STEGZERO_CARRIERS : null;
      renderMarkedText(cleanupPreview, input.value, state.report, f => {
        const detail = actions.get(f.id);
        const carrier = !!(carriers && carriers.has(f.value));
        if (!detail) return { key: 'kept' + carrier, kind: 'kept', carrier };
        if (detail.action === 'replace') return { key: 'replaced' + detail.replacement, kind: 'replaced', replacement: replacementLabel(detail.replacement) };
        return { key: 'removed' + carrier, kind: 'removed', carrier };
      });
    }

    function applyCleanup(action) {
      if (!hasCurrentReport()) return;
      const result = cleaned();
      if (!result.changes) return;
      if (action === 'copy') copy(result.text).then(() => { flashButton(copyClean, 'Copied ✓'); announce('Cleaned text copied; the source input was not changed.', false); }).catch(e => announce(e.message, true));
      else download((state.fileName ? state.fileName.replace(/(\.[^.]+)?$/, '.cleaned.txt') : 'stegzero-cleaned.txt'), result.text);
    }

    function renderTechnical() {
      const report = state.report;
      escaped.textContent = scanner.escapedView(input.value, report);
      technicalSummary.textContent = '';
      const add = (label, value) => { const item = el('div'); item.append(el('dt', '', label), el('dd', '', value)); technicalSummary.append(item); };
      add('Code points', report.input.codePoints.toLocaleString());
      add('UTF-16 units', report.input.utf16Units.toLocaleString());
      add('Distinct hidden code points', report.summary.distinctCodePoints.toLocaleString());
      add('StegZero format', FORMAT_LABELS[report.stegzero.format] || 'Not detected');
      add('StegZero status', report.stegzero.status === 'none' ? 'None' : report.stegzero.status.replaceAll('-', ' '));
      add('Unicode data', report.unicodeVersion);
    }

    function copyReport(format) {
      if (!hasCurrentReport()) return;
      copy(scanner.formatReport(state.report, format)).then(() => { flashButton(copyTextReport, 'Copied ✓'); announce('Report copied.', false); }).catch(e => announce(e.message, true));
    }
    function downloadReport() {
      if (!hasCurrentReport()) return;
      download('stegzero-unicode-report.json', scanner.formatReport(state.report, 'json'), 'application/json');
    }

    preset.addEventListener('change', () => { state.presetChosen = true; renderCleanup(); });
    removeCarrier.addEventListener('change', renderCleanup);
    if (options.contextSelect) options.contextSelect.addEventListener('change', inspectNow);
    if (options.advancedToggle) options.advancedToggle.addEventListener('change', inspectNow);
    if (options.inspectButton) options.inspectButton.addEventListener('click', inspectNow);
    input.addEventListener('input', options.listen !== false ? schedule : invalidate);
    async function processFile(file, fileInput) {
      if (!file) return;
      if (file.size > MAX_FILE_BYTES) { announce('Files must be 1 MiB or smaller.', true); if (fileInput) fileInput.value = ''; return; }
      try {
        const value = decodeLocalFile(await file.arrayBuffer());
        if (Array.from(value).length > scanner.MAX_CODE_POINTS) throw new Error('The file exceeds 500,000 Unicode code points.');
        input.value = value; state.fileName = file.name;
        const extension = (file.name.split('.').pop() || '').toLowerCase();
        if (options.contextSelect && SOURCE_EXTENSIONS.has(extension)) options.contextSelect.value = 'source';
        if (typeof options.onInputLoaded === 'function') options.onInputLoaded(file);
        inspectNow();
        announce(`Loaded ${file.name} locally. No file data was uploaded or stored.`, false);
      } catch (fileError) { announce(fileError.message || 'Unable to read this file.', true); }
    }
    if (options.fileInput) options.fileInput.addEventListener('change', event => processFile(event.target.files && event.target.files[0], event.target));
    if (options.dropZone) {
      options.dropZone.addEventListener('dragover', event => { event.preventDefault(); options.dropZone.classList.add('is-dragging'); });
      options.dropZone.addEventListener('dragleave', () => options.dropZone.classList.remove('is-dragging'));
      options.dropZone.addEventListener('drop', event => {
        const files = event.dataTransfer && event.dataTransfer.files;
        options.dropZone.classList.remove('is-dragging');
        // Dropped text keeps the browser's default insertion; only files are intercepted.
        if (!files || !files.length) return;
        event.preventDefault();
        if (files.length > 1) { announce('Choose one file at a time.', true); return; }
        processFile(files[0], options.fileInput);
      });
    }

    renderEmpty();
    return Object.freeze({ inspectNow, schedule, render, invalidate, clear: renderEmpty, getReport: () => hasCurrentReport() ? state.report : null });
  }

  root.StegZeroInspectorUI = Object.freeze({ mount, decodeLocalFile, MAX_FILE_BYTES });
})(typeof window !== 'undefined' ? window : globalThis);
