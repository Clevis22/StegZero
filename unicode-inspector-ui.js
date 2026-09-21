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
  const CODEC_LABELS = {
    'unicode-tags-ascii': 'Unicode Tag characters interpreted as ASCII',
    'variation-selector-bytes': 'Variation selectors interpreted with the common byte convention'
  };

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

  function mount(options) {
    options = options || {};
    const scanner = root.StegZeroUnicode;
    if (!scanner) throw new Error('StegZeroUnicode must load before the inspector UI.');
    const host = typeof options.root === 'string' ? document.querySelector(options.root) : options.root;
    const input = typeof options.input === 'string' ? document.querySelector(options.input) : options.input;
    if (!host || !input) throw new Error('Inspector root and input are required.');

    const pageSize = Math.max(1, Number(options.pageSize) || PAGE_SIZE);
    const state = { report: null, sourceText: null, timer: null, generation: 0, visible: pageSize, category: 'all', fileName: null };
    host.classList.add('uzi');
    host.textContent = '';

    const live = el('p', 'uzi-live sr-only');
    live.setAttribute('aria-live', 'polite');
    const error = el('div', 'uzi-notice uzi-notice-error');
    error.hidden = true;

    const summarySection = el('section', 'uzi-section');
    summarySection.append(el('h3', 'uzi-heading', 'Unicode inspection summary'));
    const verdict = el('div', 'uzi-verdict', 'No inspected hidden Unicode found');
    const summary = el('dl', 'uzi-summary');
    const technicalDetails = el('details', 'uzi-technical-summary');
    technicalDetails.append(el('summary', '', 'Technical summary'));
    const technicalSummary = el('dl', 'uzi-summary uzi-summary-technical');
    technicalDetails.append(technicalSummary);
    summarySection.append(verdict, summary, technicalDetails);

    const hiddenSection = el('details', 'uzi-section uzi-diagnostic');
    hiddenSection.append(el('summary', 'uzi-heading', 'Show hidden characters'));
    const hiddenHelp = el('p', 'uzi-help', 'This logical-order escaped view is diagnostic and may not reproduce the original text shaping. Raw bidirectional controls are never rendered here.');
    const escaped = el('pre', 'uzi-escaped');
    escaped.dir = 'ltr';
    hiddenSection.append(hiddenHelp, escaped);

    const findingsSection = el('section', 'uzi-section');
    findingsSection.append(el('h3', 'uzi-heading', 'Findings'));
    const findingsIntro = el('p', 'uzi-findings-intro');
    const chartHeader = el('div', 'uzi-chart-header');
    chartHeader.append(el('h4', '', 'Findings by category'));
    const showAllFindings = button('Show all', 'uzi-chart-reset', () => selectCategory('all'));
    showAllFindings.hidden = true;
    chartHeader.append(showAllFindings);
    const chart = el('div', 'uzi-chart');
    chart.setAttribute('aria-label', 'Findings by category. Select a bar to filter the detailed findings.');
    const rows = el('div', 'uzi-findings');
    const more = button(`Show next ${pageSize} types`, 'uzi-button uzi-button-secondary', () => { state.visible += pageSize; renderRows(); });
    findingsSection.append(findingsIntro, chartHeader, chart, rows, more);

    const candidatesSection = el('section', 'uzi-section');
    candidatesSection.append(el('h3', 'uzi-heading', 'Possible hidden payloads'));
    const candidates = el('div', 'uzi-candidates');
    candidatesSection.append(candidates);
    candidatesSection.hidden = true;

    const cleanupSection = el('section', 'uzi-section');
    cleanupSection.append(el('h3', 'uzi-heading', 'Create a cleaned copy'));
    const cleanupHelp = el('p', 'uzi-help', 'Choose what StegZero should change. Your source text above is never modified.');
    const cleanupControls = el('div', 'uzi-cleanup-controls');
    const presetLabel = el('label', 'uzi-control');
    presetLabel.append(el('span', '', 'Cleanup level'));
    const preset = el('select', 'uzi-select');
    [['conservative','Recommended (low impact)'],['security','Security-focused'],['custom','Custom'],['aggressive','Aggressive (may alter text)']].forEach(([value, label]) => {
      const option = el('option', '', label); option.value = value; preset.append(option);
    });
    presetLabel.append(preset);
    const removeCarrierLabel = el('label', 'uzi-check');
    const removeCarrier = document.createElement('input'); removeCarrier.type = 'checkbox';
    removeCarrierLabel.append(removeCarrier, el('span', '', 'Also remove StegZero carrier characters'));
    removeCarrierLabel.hidden = true;
    cleanupControls.append(presetLabel, removeCarrierLabel);
    const cleanupDescription = el('p', 'uzi-cleanup-description');
    const cleanupAdvanced = el('details', 'uzi-cleanup-advanced');
    const cleanupAdvancedSummary = el('summary', '', 'Choose additional character types');
    const categoryChecks = el('fieldset', 'uzi-category-checks');
    const legend = el('legend', '', 'Character types to remove');
    categoryChecks.append(legend);
    cleanupAdvanced.append(cleanupAdvancedSummary, categoryChecks);
    const changeSummary = el('div', 'uzi-change-summary');
    changeSummary.append(el('h4', '', 'What will change'));
    const cleanupMeta = el('p', 'uzi-cleanup-meta', 'Recommended cleanup would not change this text.');
    const changeList = el('ul', 'uzi-change-list');
    changeSummary.append(cleanupMeta, changeList);
    const cleanupPreview = el('div', 'uzi-cleanup-preview');
    cleanupPreview.append(el('h4', '', 'Affected preview'));
    const cleanupPreviewMeta = el('p', 'uzi-help');
    const cleanupPreviewList = el('div', 'uzi-preview-list');
    cleanupPreview.append(cleanupPreviewMeta, cleanupPreviewList);
    cleanupPreview.hidden = true;
    const cleanupActions = el('div', 'uzi-actions');
    const copyClean = button('Copy cleaned text', 'uzi-button', () => applyCleanup('copy'));
    const downloadClean = button('Download cleaned .txt', 'uzi-button uzi-button-secondary', () => applyCleanup('download'));
    cleanupActions.append(copyClean, downloadClean);
    cleanupSection.append(cleanupHelp, cleanupControls, cleanupDescription, cleanupAdvanced, changeSummary, cleanupPreview, cleanupActions);

    const reportSection = el('section', 'uzi-section uzi-report-section');
    reportSection.append(el('h3', 'uzi-heading', 'Export inspection report'));
    reportSection.append(el('p', 'uzi-help', 'Reports include every finding, including occurrences not expanded above.'));
    const reportActions = el('div', 'uzi-actions');
    const copyTextReport = button('Copy text report', 'uzi-button uzi-button-secondary', () => copyReport('text'));
    const downloadJson = button('Download JSON report', 'uzi-button uzi-button-secondary', () => downloadReport());
    reportActions.append(copyTextReport, downloadJson);
    reportSection.append(reportActions);

    host.append(live, error, summarySection, hiddenSection, findingsSection, candidatesSection, cleanupSection, reportSection);

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
        if (options.announceInspection !== false) announce(`Inspection complete: ${report.summary.findingCount.toLocaleString()} finding${report.summary.findingCount === 1 ? '' : 's'}.`, false);
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
      copyTextReport.disabled = false;
      downloadJson.disabled = false;
      state.visible = pageSize;
      state.category = 'all';
      renderSummary();
      renderEscaped();
      renderFilters();
      renderRows();
      renderCandidates();
      renderCleanupChecks();
      renderCleanup();
      host.hidden = false;
    }

    function renderEmpty() {
      invalidate();
      verdict.textContent = 'No current inspection';
      candidatesSection.hidden = true;
      summary.textContent = '';
      technicalSummary.textContent = '';
      escaped.textContent = '';
      findingsIntro.textContent = '';
      chart.textContent = '';
      chartHeader.hidden = true;
      showAllFindings.hidden = true;
      rows.textContent = '';
      candidates.textContent = '';
      categoryChecks.replaceChildren(legend);
      cleanupAdvanced.hidden = true;
      cleanupMeta.textContent = 'Recommended cleanup would not change this text.';
      changeList.textContent = '';
      cleanupPreview.hidden = true;
      cleanupPreviewList.textContent = '';
      copyClean.disabled = true;
      downloadClean.disabled = true;
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
      verdict.textContent = 'Text changed; a new inspection is needed.';
      cleanupMeta.textContent = 'Inspect the current text before creating a cleaned copy.';
    }

    function hasCurrentReport() {
      return !!state.report && state.sourceText === input.value;
    }

    function addSummary(target, label, value) {
      const item = el('div'); item.append(el('dt', '', label), el('dd', '', value));
      target.append(item);
    }

    function renderSummary() {
      const report = state.report;
      const count = report.summary.findingCount;
      let verdictText = 'No inspected hidden Unicode found';
      if (report.stegzero.status === 'decoded') verdictText = 'Hidden message found';
      else if (report.stegzero.status === 'passphrase-required') verdictText = 'StegZero data found; a passphrase may be required';
      else if (report.candidates.length) verdictText = 'Non-StegZero hidden-data candidate found';
      else if (count) verdictText = 'Unicode findings present; no decodable payload found';
      verdict.textContent = verdictText;
      verdict.dataset.assessment = report.summary.highestAssessment || 'none';
      summary.textContent = '';
      technicalSummary.textContent = '';
      addSummary(summary, 'Findings', count.toLocaleString());
      addSummary(summary, 'Highest assessment', assessmentLabel(report.summary.highestAssessment));
      addSummary(summary, 'StegZero format', FORMAT_LABELS[report.stegzero.format] || 'Not detected');
      addSummary(summary, 'StegZero status', report.stegzero.status === 'none' ? 'None' : report.stegzero.status.replaceAll('-', ' '));
      addSummary(technicalSummary, 'Unicode code points', report.input.codePoints.toLocaleString());
      addSummary(technicalSummary, 'UTF-16 code units', report.input.utf16Units.toLocaleString());
      addSummary(technicalSummary, 'Distinct code points', report.summary.distinctCodePoints.toLocaleString());
      addSummary(technicalSummary, 'Categories', Object.keys(report.summary.categories).length.toLocaleString());
      addSummary(technicalSummary, 'Unicode data', report.unicodeVersion);
    }

    function renderEscaped() { escaped.textContent = scanner.escapedView(input.value, state.report); }

    function renderFilters() {
      chart.textContent = '';
      showAllFindings.hidden = true;
      const counts = state.report.summary.categories;
      const categories = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || (CATEGORY_LABELS[a] || a).localeCompare(CATEGORY_LABELS[b] || b));
      const categoryCount = categories.length;
      findingsIntro.textContent = state.report.summary.findingCount
        ? `${state.report.summary.findingCount.toLocaleString()} hidden Unicode character${state.report.summary.findingCount === 1 ? '' : 's'} found across ${categoryCount.toLocaleString()} categor${categoryCount === 1 ? 'y' : 'ies'}. Select a bar to filter the grouped findings.`
        : 'No inspected hidden Unicode characters were found.';
      const maximum = Math.max(1, ...Object.values(counts));
      categories.forEach(category => {
        const label = CATEGORY_LABELS[category] || category;
        const chartButton = button('', 'uzi-chart-row', () => selectCategory(state.category === category ? 'all' : category));
        chartButton.dataset.category = category;
        chartButton.setAttribute('aria-label', `${label}: ${counts[category].toLocaleString()} finding${counts[category] === 1 ? '' : 's'}`);
        chartButton.setAttribute('aria-pressed', 'false');
        chartButton.append(el('span', 'uzi-chart-label', label));
        const track = el('span', 'uzi-chart-track');
        const bar = el('span', 'uzi-chart-bar');
        bar.style.width = `${Math.max(4, (counts[category] / maximum) * 100)}%`;
        track.append(bar);
        chartButton.append(track, el('span', 'uzi-chart-count', counts[category].toLocaleString()));
        chart.append(chartButton);
      });
      chartHeader.hidden = !categories.length;
    }

    function selectCategory(category) {
      if (!hasCurrentReport()) return;
      state.category = category; state.visible = pageSize;
      chart.querySelectorAll('button').forEach(node => {
        const active = node.dataset.category === category;
        node.classList.toggle('is-active', active);
        node.setAttribute('aria-pressed', String(active));
      });
      showAllFindings.hidden = category === 'all';
      renderRows();
    }

    function filteredFindings() {
      return state.category === 'all' ? state.report.findings : state.report.findings.filter(f => f.category === state.category);
    }

    function renderRows() {
      if (!hasCurrentReport()) return;
      const findings = filteredFindings();
      rows.textContent = '';
      if (!findings.length) {
        rows.append(el('p', 'uzi-empty', 'No findings in this category.'));
        more.hidden = true;
        return;
      }
      const groups = new Map();
      findings.forEach(f => {
        const key = `${f.category}|${f.codePoint}`;
        if (!groups.has(key)) groups.set(key, { finding: f, findings: [] });
        groups.get(key).findings.push(f);
      });
      const grouped = Array.from(groups.values()).sort((a, b) => b.findings.length - a.findings.length || a.finding.codePoint.localeCompare(b.finding.codePoint));
      grouped.slice(0, state.visible).forEach(group => {
        const finding = group.finding;
        const highest = group.findings.reduce((value, item) => {
          const rank = { expected: 0, review: 1, suspicious: 2 };
          return rank[item.assessment] > rank[value] ? item.assessment : value;
        }, 'expected');
        const details = el('details', 'uzi-finding uzi-finding-group');
        const head = el('summary');
        const identity = el('span', 'uzi-finding-identity');
        identity.append(el('span', 'uzi-finding-name', finding.name), el('span', 'uzi-finding-codepoint', `${finding.codePoint} · ${CATEGORY_LABELS[finding.category] || finding.category}`));
        head.append(el('code', 'uzi-token', finding.token), identity, el('span', 'uzi-occurrence-count', `${group.findings.length.toLocaleString()} occurrence${group.findings.length === 1 ? '' : 's'}`), el('span', `uzi-assessment is-${highest}`, assessmentLabel(highest)));
        const body = el('div', 'uzi-finding-body');
        body.append(el('p', 'uzi-help', 'Expand an occurrence for its exact position, context, explanation, and cleanup treatment.'));
        const occurrenceList = el('div', 'uzi-occurrences');
        body.append(occurrenceList);
        let occurrenceVisible = Math.min(20, pageSize);
        const renderOccurrences = () => {
          if (!hasCurrentReport()) return;
          occurrenceList.textContent = '';
          group.findings.slice(0, occurrenceVisible).forEach(item => occurrenceList.append(renderOccurrence(item)));
          if (group.findings.length > occurrenceVisible) {
            const remaining = group.findings.length - occurrenceVisible;
            occurrenceList.append(button(`Show next ${Math.min(20, remaining)} occurrences (${remaining.toLocaleString()} remaining)`, 'uzi-button uzi-button-secondary uzi-occurrence-more', () => { occurrenceVisible += 20; renderOccurrences(); }));
          }
        };
        details.addEventListener('toggle', () => {
          if (details.open && !details.dataset.rendered) { details.dataset.rendered = 'true'; renderOccurrences(); }
        });
        details.append(head, body); rows.append(details);
      });
      more.hidden = grouped.length <= state.visible;
      if (!more.hidden) {
        const remaining = grouped.length - state.visible;
        more.textContent = `Show next ${Math.min(pageSize, remaining).toLocaleString()} types (${remaining.toLocaleString()} remaining)`;
      }
    }

    function renderOccurrence(finding) {
      const details = el('details', 'uzi-occurrence');
      const head = el('summary');
      head.append(el('span', 'uzi-position', `Position ${finding.codePointIndex} · line ${finding.line}, column ${finding.column}`), el('span', `uzi-assessment is-${finding.assessment}`, assessmentLabel(finding.assessment)));
      const body = el('div', 'uzi-occurrence-body');
      const context = el('pre', 'uzi-context'); context.dir = 'ltr'; context.textContent = scanner.contextFor(input.value, finding, 20);
      const treatment = finding.cleanupDefault === 'remove' ? 'Recommended cleanup removes this occurrence.' : 'Recommended cleanup preserves this occurrence.';
      body.append(el('p', '', finding.reason), context, el('p', 'uzi-treatment', treatment), el('p', 'uzi-position', `UTF-16 offset ${finding.utf16Offset}`));
      details.append(head, body);
      return details;
    }

    function renderCandidates() {
      candidates.textContent = '';
      const list = state.report.candidates;
      candidatesSection.hidden = !list.length;
      list.forEach(candidate => {
        const card = el('article', 'uzi-candidate');
        card.append(el('h4', '', candidate.label), el('p', 'uzi-help', `Carrier: ${CODEC_LABELS[candidate.codec] || candidate.codec}. This is a possible decoded payload, not a definitive attribution.`));
        card.append(el('p', 'uzi-help', `Validation: ${candidate.validation.join('; ')}.`));
        if (candidate.decodedText !== null) {
          const decoded = el('pre', 'uzi-candidate-value');
          const decodedReport = scanner.inspect(candidate.decodedText, { context: 'plain', includeAdvanced: true });
          decoded.textContent = scanner.escapedView(candidate.decodedText, decodedReport);
          card.append(decoded, button('Copy decoded text', 'uzi-button uzi-button-secondary', () => copy(candidate.decodedText).catch(e => announce(e.message, true))));
        }
        const bytes = el('pre', 'uzi-candidate-value'); bytes.textContent = candidate.escapedBytes;
        card.append(bytes, button('Copy escaped bytes', 'uzi-button uzi-button-secondary', () => copy(candidate.escapedBytes).catch(e => announce(e.message, true))));
        candidates.append(card);
      });
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
      const descriptions = {
        conservative: 'Recommended cleanup removes only malformed, deprecated, or ineffectual characters. Legitimate formatting, emoji, multilingual shaping, spaces, and bidi controls are preserved.',
        security: 'Security-focused cleanup also removes bidi controls, suspicious payload-like characters, and confirmed StegZero carriers. Join controls and unusual spaces remain unless you add them below.',
        custom: 'Custom cleanup changes only the character types you select below.',
        aggressive: 'Aggressive cleanup removes every detected category and normalizes unusual spaces. It can change emoji, multilingual shaping, line breaking, collation, and mathematical meaning.'
      };
      cleanupDescription.textContent = descriptions[preset.value];
      cleanupAdvancedSummary.textContent = preset.value === 'custom' ? 'Choose character types to remove' : 'Choose additional character types';
      if (preset.value === 'custom') cleanupAdvanced.open = true;
      const hasStegZero = !!(state.report.stegzero && state.report.stegzero.format && state.report.stegzero.status !== 'none');
      removeCarrierLabel.hidden = !hasStegZero;
      if (!hasStegZero) removeCarrier.checked = false;
      const result = cleaned();
      cleanupHelp.textContent = 'Choose what StegZero should change. Your source text above is never modified.';
      changeList.textContent = '';
      changeSummary.dataset.empty = String(result.changes === 0);
      if (!result.changes) {
        const levelName = preset.options[preset.selectedIndex].text.replace(/\s*\(.+\)$/, '');
        cleanupMeta.textContent = `${levelName} cleanup would not change this text.`;
      } else {
        cleanupMeta.textContent = `This will make ${result.changes.toLocaleString()} change${result.changes === 1 ? '' : 's'} to a new copy.`;
        result.changeDetails.forEach(detail => {
          const category = CATEGORY_LABELS[detail.category] || (detail.category === 'stegzero-carrier' ? 'StegZero carriers' : detail.category);
          const count = detail.count.toLocaleString();
          const item = el('li');
          if (detail.action === 'replace') {
            const replacement = detail.replacement === '\n' ? 'line feed' : detail.replacement === ' ' ? 'ordinary space' : 'replacement text';
            item.textContent = `Replace ${count} × ${detail.token} with ${replacement} (${category}).`;
          } else item.textContent = `Remove ${count} × ${detail.token} (${category}).`;
          changeList.append(item);
        });
        const changedFindingCount = new Set(result.changedFindingIds).size;
        const preserved = Math.max(0, state.report.findings.length - changedFindingCount);
        if (preserved) changeList.append(el('li', 'uzi-preserved', `Keep ${preserved.toLocaleString()} other finding${preserved === 1 ? '' : 's'} unchanged.`));
      }
      renderCleanupPreview(result);
      copyClean.disabled = result.changes === 0;
      downloadClean.disabled = result.changes === 0;
      const disabledTitle = result.changes === 0 ? 'The selected cleanup level makes no changes.' : '';
      copyClean.title = disabledTitle;
      downloadClean.title = disabledTitle;
    }

    function replacementToken(value) {
      if (value === ' ') return '[SPACE]';
      if (value === '\n') return '[LF]';
      return value;
    }

    function renderCleanupPreview(result) {
      cleanupPreviewList.textContent = '';
      cleanupPreview.hidden = result.changes === 0;
      if (!result.changes) return;
      const detailsByFinding = new Map();
      result.changeDetails.forEach(detail => detail.findingIds.forEach(id => detailsByFinding.set(id, detail)));
      const affected = state.report.findings.filter(finding => detailsByFinding.has(finding.id)).slice(0, 5);
      cleanupPreviewMeta.textContent = affected.length
        ? `Showing ${affected.length.toLocaleString()} affected context${affected.length === 1 ? '' : 's'}${result.changes > affected.length ? ` from ${result.changes.toLocaleString()} total changes` : ''}. Escaped tokens make invisible characters readable.`
        : 'StegZero carrier characters will be removed throughout the cleaned copy.';
      affected.forEach(finding => {
        const detail = detailsByFinding.get(finding.id);
        const before = scanner.contextFor(input.value, finding, 12);
        const replacement = detail.action === 'replace' ? `⟦${replacementToken(detail.replacement)}⟧` : '';
        const highlighted = `⟦${finding.token}⟧`;
        const after = before.includes(highlighted) ? before.replace(highlighted, replacement) : before.replace(finding.token, replacement);
        const item = el('article', 'uzi-preview-change');
        item.append(el('p', 'uzi-preview-label', `${finding.token} at position ${finding.codePointIndex}`));
        const comparison = el('div', 'uzi-preview-comparison');
        const beforeLine = el('div'); beforeLine.append(el('span', '', 'Before'), el('code', '', before));
        const afterLine = el('div'); afterLine.append(el('span', '', 'After'), el('code', '', after));
        comparison.append(beforeLine, afterLine);
        item.append(comparison);
        cleanupPreviewList.append(item);
      });
    }

    function confirmAggressive() {
      return preset.value !== 'aggressive' || root.confirm('Aggressive cleanup can change emoji appearance, multilingual shaping, line breaking, collation, and mathematical meaning. Continue with the cleaned copy?');
    }

    function applyCleanup(action) {
      if (!hasCurrentReport() || !confirmAggressive()) return;
      const result = cleaned();
      if (!result.changes) return;
      if (action === 'copy') copy(result.text).then(() => announce('Cleaned text copied; the source input was not changed.', false)).catch(e => announce(e.message, true));
      else download((state.fileName ? state.fileName.replace(/(\.[^.]+)?$/, '.cleaned.txt') : 'stegzero-cleaned.txt'), result.text);
    }

    function copyReport(format) {
      if (!hasCurrentReport()) return;
      copy(scanner.formatReport(state.report, format)).then(() => announce('Report copied.', false)).catch(e => announce(e.message, true));
    }
    function downloadReport() {
      if (!hasCurrentReport()) return;
      download('stegzero-unicode-report.json', scanner.formatReport(state.report, 'json'), 'application/json');
    }

    preset.addEventListener('change', renderCleanup);
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
        event.preventDefault(); options.dropZone.classList.remove('is-dragging');
        const files = event.dataTransfer && event.dataTransfer.files;
        if (files && files.length > 1) { announce('Choose one file at a time.', true); return; }
        processFile(files && files[0], options.fileInput);
      });
    }

    renderEmpty();
    return Object.freeze({ inspectNow, schedule, render, invalidate, clear: renderEmpty, getReport: () => hasCurrentReport() ? state.report : null });
  }

  root.StegZeroInspectorUI = Object.freeze({ mount, decodeLocalFile, MAX_FILE_BYTES });
})(typeof window !== 'undefined' ? window : globalThis);
