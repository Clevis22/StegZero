(function (root) {
  'use strict';

  const PINNED_DATA = root.StegZeroUnicodeData || null;
  const DATA_VERSION = '17.0.0';
  if (PINNED_DATA && PINNED_DATA.version !== DATA_VERSION) throw new Error('StegZero Unicode data version mismatch');
  const MAX_CODE_POINTS = 500000;
  // Bind reports to their input without including source text in exported reports.
  const reportSources = new WeakMap();

  const CP = {
    0x00AD: ['SOFT HYPHEN', 'SHY'], 0x034F: ['COMBINING GRAPHEME JOINER', 'CGJ'],
    0x061C: ['ARABIC LETTER MARK', 'ALM'], 0x115F: ['HANGUL CHOSEONG FILLER', 'HCF'],
    0x1160: ['HANGUL JUNGSEONG FILLER', 'HJF'], 0x180E: ['MONGOLIAN VOWEL SEPARATOR', 'MVS'],
    0x200B: ['ZERO WIDTH SPACE', 'ZWSP'], 0x200C: ['ZERO WIDTH NON-JOINER', 'ZWNJ'],
    0x200D: ['ZERO WIDTH JOINER', 'ZWJ'], 0x200E: ['LEFT-TO-RIGHT MARK', 'LRM'],
    0x200F: ['RIGHT-TO-LEFT MARK', 'RLM'], 0x2028: ['LINE SEPARATOR', 'LS'],
    0x2029: ['PARAGRAPH SEPARATOR', 'PS'], 0x202A: ['LEFT-TO-RIGHT EMBEDDING', 'LRE'],
    0x202B: ['RIGHT-TO-LEFT EMBEDDING', 'RLE'], 0x202C: ['POP DIRECTIONAL FORMATTING', 'PDF'],
    0x202D: ['LEFT-TO-RIGHT OVERRIDE', 'LRO'], 0x202E: ['RIGHT-TO-LEFT OVERRIDE', 'RLO'],
    0x2060: ['WORD JOINER', 'WJ'], 0x2061: ['FUNCTION APPLICATION', 'FAPP'],
    0x2062: ['INVISIBLE TIMES', 'ITIMES'], 0x2063: ['INVISIBLE SEPARATOR', 'ISEP'],
    0x2064: ['INVISIBLE PLUS', 'IPLUS'], 0x2066: ['LEFT-TO-RIGHT ISOLATE', 'LRI'],
    0x2067: ['RIGHT-TO-LEFT ISOLATE', 'RLI'], 0x2068: ['FIRST STRONG ISOLATE', 'FSI'],
    0x2069: ['POP DIRECTIONAL ISOLATE', 'PDI'], 0x2800: ['BRAILLE PATTERN BLANK', 'BRAILLE BLANK'],
    0x3164: ['HANGUL FILLER', 'HANGUL FILLER'], 0xFFA0: ['HALFWIDTH HANGUL FILLER', 'HW HANGUL FILLER'],
    0xFEFF: ['ZERO WIDTH NO-BREAK SPACE / BYTE ORDER MARK', 'BOM'],
    0xE0001: ['LANGUAGE TAG', 'LANGUAGE TAG'], 0xE007F: ['CANCEL TAG', 'CANCEL TAG']
  };

  const SPACE_NAMES = {
    0x00A0: 'NO-BREAK SPACE', 0x1680: 'OGHAM SPACE MARK', 0x2000: 'EN QUAD',
    0x2001: 'EM QUAD', 0x2002: 'EN SPACE', 0x2003: 'EM SPACE', 0x2004: 'THREE-PER-EM SPACE',
    0x2005: 'FOUR-PER-EM SPACE', 0x2006: 'SIX-PER-EM SPACE', 0x2007: 'FIGURE SPACE',
    0x2008: 'PUNCTUATION SPACE', 0x2009: 'THIN SPACE', 0x200A: 'HAIR SPACE',
    0x202F: 'NARROW NO-BREAK SPACE', 0x205F: 'MEDIUM MATHEMATICAL SPACE', 0x3000: 'IDEOGRAPHIC SPACE'
  };

  const CONTROL_NAMES = {
    0: 'NULL', 1: 'START OF HEADING', 2: 'START OF TEXT', 3: 'END OF TEXT', 4: 'END OF TRANSMISSION',
    5: 'ENQUIRY', 6: 'ACKNOWLEDGE', 7: 'BELL', 8: 'BACKSPACE', 11: 'LINE TABULATION',
    12: 'FORM FEED', 14: 'SHIFT OUT', 15: 'SHIFT IN', 16: 'DATA LINK ESCAPE',
    17: 'DEVICE CONTROL ONE', 18: 'DEVICE CONTROL TWO', 19: 'DEVICE CONTROL THREE',
    20: 'DEVICE CONTROL FOUR', 21: 'NEGATIVE ACKNOWLEDGE', 22: 'SYNCHRONOUS IDLE',
    23: 'END OF TRANSMISSION BLOCK', 24: 'CANCEL', 25: 'END OF MEDIUM', 26: 'SUBSTITUTE',
    27: 'ESCAPE', 28: 'INFORMATION SEPARATOR FOUR', 29: 'INFORMATION SEPARATOR THREE',
    30: 'INFORMATION SEPARATOR TWO', 31: 'INFORMATION SEPARATOR ONE', 127: 'DELETE'
  };

  const DEPRECATED_FORMAT = new Set([0x206A, 0x206B, 0x206C, 0x206D, 0x206E, 0x206F]);
  const BIDI = new Set([0x061C, 0x200E, 0x200F, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069]);
  const BIDI_OPEN = new Set([0x202A, 0x202B, 0x202D, 0x202E]);
  const BIDI_ISOLATE = new Set([0x2066, 0x2067, 0x2068]);
  const JOIN = new Set([0x200C, 0x200D]);
  const BREAK_FORMAT = new Set([0x00AD, 0x034F, 0x200B, 0x2060, 0xFEFF]);
  const MATH_INVISIBLE = new Set([0x2061, 0x2062, 0x2063, 0x2064]);
  const BLANK_FILLERS = new Set([0x115F, 0x1160, 0x180E, 0x2800, 0x3164, 0xFFA0]);
  const sequenceKey = sequence => sequence.map(cp => cp.toString(16).toUpperCase()).join('-');
  const generatedSequenceSet = name => new Set(((PINNED_DATA && PINNED_DATA[name]) || []).map(sequenceKey));
  const STANDARDIZED_VARIATIONS = generatedSequenceSet('standardizedVariations');
  const EMOJI_VARIATIONS = generatedSequenceSet('emojiVariations');
  const EMOJI_ZWJ = generatedSequenceSet('emojiZwjSequences');
  const RGI_TAGS = new Set(((PINNED_DATA && PINNED_DATA.rgiEmojiSequences) || []).filter(sequence => sequence[0] === 0x1F3F4 && sequence[sequence.length - 1] === 0xE007F).map(sequence => sequence.slice(1, -1).map(cp => String.fromCodePoint(cp - 0xE0000)).join('')));
  if (!RGI_TAGS.size) ['gbeng', 'gbsct', 'gbwls'].forEach(value => RGI_TAGS.add(value));
  const ADVANCED_CATEGORIES = new Set(['private-use', 'noncharacter', 'unassigned', 'orphan-combining-mark']);

  const STANDALONE_VALID_VARIATIONS = new Set([
    '0023-FE0E','0023-FE0F','002A-FE0E','002A-FE0F','0030-FE0E','0030-FE0F','0031-FE0E','0031-FE0F',
    '0032-FE0E','0032-FE0F','0033-FE0E','0033-FE0F','0034-FE0E','0034-FE0F','0035-FE0E','0035-FE0F',
    '0036-FE0E','0036-FE0F','0037-FE0E','0037-FE0F','0038-FE0E','0038-FE0F','0039-FE0E','0039-FE0F',
    '00A9-FE0E','00A9-FE0F','00AE-FE0E','00AE-FE0F','203C-FE0E','203C-FE0F','2049-FE0E','2049-FE0F',
    '2122-FE0E','2122-FE0F','2139-FE0E','2139-FE0F','2764-FE0E','2764-FE0F','3030-FE0E','3030-FE0F',
    '303D-FE0E','303D-FE0F','3297-FE0E','3297-FE0F','3299-FE0E','3299-FE0F'
  ]);

  function safeRegex(source) {
    try { return new RegExp(source, 'u'); } catch (_) { return null; }
  }
  const RE = {
    whitespace: safeRegex('\\p{White_Space}'), assigned: safeRegex('\\p{Assigned}'),
    defaultIgnorable: safeRegex('\\p{Default_Ignorable_Code_Point}'), format: safeRegex('\\p{Cf}'),
    mark: safeRegex('\\p{Mark}'), letter: safeRegex('[\\p{Letter}\\p{Mark}]'),
    emoji: safeRegex('\\p{Emoji}'), pictographic: safeRegex('\\p{Extended_Pictographic}'),
    privateUse: safeRegex('\\p{Co}'), math: safeRegex('[\\p{Math}\\p{Number}]')
  };
  function matches(re, value) { return !!re && re.test(value); }
  function inRange(cp, a, b) { return cp >= a && cp <= b; }
  function inDataRanges(cp, ranges) {
    if (!ranges || !ranges.length) return false;
    let low = 0, high = ranges.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1, range = ranges[middle];
      if (cp < range[0]) high = middle - 1;
      else if (cp > range[1]) low = middle + 1;
      else return true;
    }
    return false;
  }
  function isTag(cp) { return inRange(cp, 0xE0000, 0xE007F); }
  function isVariation(cp) { return inRange(cp, 0x180B, 0x180D) || cp === 0x180F || inRange(cp, 0xFE00, 0xFE0F) || inRange(cp, 0xE0100, 0xE01EF); }
  function isControl(cp) { return (inRange(cp, 0, 0x1F) && ![9, 10, 13].includes(cp)) || inRange(cp, 0x7F, 0x9F); }
  function isNoncharacter(cp) { return inRange(cp, 0xFDD0, 0xFDEF) || (cp <= 0x10FFFF && (cp & 0xFFFF) >= 0xFFFE); }
  function isCjk(cp) { return inRange(cp, 0x3400, 0x4DBF) || inRange(cp, 0x4E00, 0x9FFF) || inRange(cp, 0x20000, 0x323AF); }
  function cpText(cp) { return 'U+' + cp.toString(16).toUpperCase().padStart(cp <= 0xFFFF ? 4 : 6, '0'); }
  function rawCodePoint(value) { return value.codePointAt(0); }

  function unicodeName(cp) {
    if (PINNED_DATA && PINNED_DATA.names && PINNED_DATA.names[cp]) return PINNED_DATA.names[cp];
    if (CP[cp]) return CP[cp][0];
    if (SPACE_NAMES[cp]) return SPACE_NAMES[cp];
    if (CONTROL_NAMES[cp]) return CONTROL_NAMES[cp];
    if (inRange(cp, 0x80, 0x9F)) return 'C1 CONTROL';
    if (inRange(cp, 0x180B, 0x180D)) return 'MONGOLIAN FREE VARIATION SELECTOR ' + (cp - 0x180A);
    if (cp === 0x180F) return 'MONGOLIAN FREE VARIATION SELECTOR FOUR';
    if (inRange(cp, 0xFE00, 0xFE0F)) return 'VARIATION SELECTOR-' + (cp - 0xFDFF);
    if (inRange(cp, 0xE0100, 0xE01EF)) return 'VARIATION SELECTOR-' + (cp - 0xE00EF);
    if (inRange(cp, 0xE0020, 0xE007E)) return 'TAG ' + String.fromCodePoint(cp - 0xE0000);
    if (DEPRECATED_FORMAT.has(cp)) return 'DEPRECATED FORMAT CONTROL';
    if (isNoncharacter(cp)) return 'NONCHARACTER';
    if (matches(RE.privateUse, String.fromCodePoint(cp))) return 'PRIVATE-USE CHARACTER';
    return 'Unicode name unavailable';
  }

  function tokenFor(cp) {
    if (CP[cp]) return '[' + CP[cp][1] + ']';
    if (SPACE_NAMES[cp]) return '[' + SPACE_NAMES[cp].replace(/ SPACE$/, '').replaceAll(' ', '-') + ']';
    if (CONTROL_NAMES[cp]) return '[' + (cp === 0 ? 'NUL' : CONTROL_NAMES[cp]) + ']';
    if (inRange(cp, 0x80, 0x9F)) return '[C1-' + cpText(cp) + ']';
    if (inRange(cp, 0xFE00, 0xFE0F)) return '[VS' + (cp - 0xFDFF) + ']';
    if (inRange(cp, 0xE0100, 0xE01EF)) return '[VS' + (cp - 0xE00EF) + ']';
    if (inRange(cp, 0x180B, 0x180D) || cp === 0x180F) return '[MVS]';
    if (inRange(cp, 0xE0020, 0xE007E)) return '[TAG:' + String.fromCodePoint(cp - 0xE0000) + ']';
    return '[' + cpText(cp) + ']';
  }

  function severityRank(value) { return value === 'suspicious' ? 2 : value === 'review' ? 1 : 0; }
  function findingBase(item, category, assessment, reason, contextKind, cleanupDefault) {
    return {
      id: 'f' + item.codePointIndex,
      value: item.value,
      codePoint: cpText(item.cp),
      codePointValue: item.cp,
      name: unicodeName(item.cp),
      token: tokenFor(item.cp),
      category,
      assessment,
      reason,
      codePointIndex: item.codePointIndex,
      utf16Offset: item.utf16Offset,
      utf16Length: item.value.length,
      line: item.line,
      column: item.column,
      contextKind,
      cleanupDefault: cleanupDefault || 'preserve'
    };
  }

  function expectedEmojiVariation(items, index) {
    const cp = items[index].cp;
    if (cp !== 0xFE0E && cp !== 0xFE0F) return false;
    const prev = items[index - 1];
    if (!prev) return false;
    const key = prev.cp.toString(16).toUpperCase().padStart(4, '0') + '-' + cp.toString(16).toUpperCase();
    const generatedKey = prev.cp.toString(16).toUpperCase() + '-' + cp.toString(16).toUpperCase();
    return EMOJI_VARIATIONS.has(generatedKey) || STANDARDIZED_VARIATIONS.has(generatedKey) || STANDALONE_VALID_VARIATIONS.has(key);
  }

  function expectedStandardizedVariation(items, index) {
    const previous = items[index - 1];
    return !!previous && STANDARDIZED_VARIATIONS.has(sequenceKey([previous.cp, items[index].cp]));
  }

  function joiningType(cp) {
    if (!PINNED_DATA || !PINNED_DATA.joiningType) return null;
    let low = 0, high = PINNED_DATA.joiningType.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1, range = PINNED_DATA.joiningType[middle];
      if (cp < range[0]) high = middle - 1;
      else if (cp > range[1]) low = middle + 1;
      else return range[2];
    }
    return null;
  }

  function isRecognizedZwj(items, index) {
    if (!EMOJI_ZWJ.size) return false;
    const min = Math.max(0, index - 12), max = Math.min(items.length - 1, index + 12);
    for (let start = min; start <= index; start++) {
      const cps = [];
      for (let end = start; end <= max; end++) {
        cps.push(items[end].cp);
        if (end >= index && EMOJI_ZWJ.has(sequenceKey(cps))) return true;
      }
    }
    return false;
  }

  function expectedJoinContext(items, index) {
    const item = items[index];
    const prev = items[index - 1], next = items[index + 1];
    if (item.cp === 0x200D && isRecognizedZwj(items, index)) return 'emoji';
    if (prev && next) {
      const prevType = joiningType(prev.cp), nextType = joiningType(next.cp);
      if ((prevType && nextType && /[DLRTC]/.test(prevType) && /[DLRTC]/.test(nextType)) || (matches(RE.letter, prev.value) && matches(RE.letter, next.value))) return 'orthographic';
    }
    return null;
  }

  function classify(items, index, options) {
    const item = items[index], cp = item.cp, value = item.value;
    const context = options.context || 'plain';
    if (BIDI.has(cp)) {
      const explicitOverride = cp === 0x202D || cp === 0x202E;
      const suspicious = explicitOverride || context !== 'plain';
      return findingBase(item, 'bidi-control', suspicious ? 'suspicious' : 'review',
        suspicious ? 'This directional control can make logical text order differ from its display in this context.' : 'Directional controls are legitimate in multilingual text but should be reviewed.',
        'directional-formatting', 'preserve');
    }
    if (isTag(cp)) return findingBase(item, 'unicode-tag', 'suspicious', 'Tag characters are invisible outside a valid emoji tag sequence and can carry hidden ASCII text.', 'unvalidated-tag', 'remove');
    if (isVariation(cp)) {
      if (expectedEmojiVariation(items, index)) return findingBase(item, 'variation-selector', 'expected', 'This selector requests a recognized emoji or text presentation.', 'valid-emoji-variation', 'preserve');
      if (expectedStandardizedVariation(items, index)) return findingBase(item, 'variation-selector', 'expected', 'This selector participates in a Unicode 17 standardized variation sequence.', 'valid-standardized-variation', 'preserve');
      const prev = items[index - 1];
      if (prev && isCjk(prev.cp) && cp >= 0xE0100) return findingBase(item, 'variation-selector', 'review', 'This may be a legitimate ideographic variation sequence; the full IVD is not validated here.', 'possible-ideographic-variation', 'preserve');
      const attached = !!prev && !isVariation(prev.cp) && !isControl(prev.cp) && !BIDI.has(prev.cp);
      return findingBase(item, 'variation-selector', attached ? 'review' : 'suspicious', attached ? 'This selector may request a glyph variant, but it is not recognized by the bundled sequence data.' : 'This selector is detached or repeated and is unlikely to affect a valid base character.', attached ? 'unregistered-variation' : 'orphan-variation', attached ? 'preserve' : 'remove');
    }
    if (JOIN.has(cp)) {
      const expected = expectedJoinContext(items, index);
      return findingBase(item, 'join-control', expected ? (expected === 'emoji' ? 'expected' : 'review') : 'review', expected === 'emoji' ? 'This joiner participates in an emoji sequence.' : expected === 'orthographic' ? 'This join control appears between letters and may be orthographically significant.' : 'Join controls can affect emoji, ligatures, and cursive-script shaping.', expected || 'contextual-joiner', 'preserve');
    }
    if (BREAK_FORMAT.has(cp)) {
      if (cp === 0xFEFF && item.utf16Offset === 0) return findingBase(item, 'line-word-format', 'expected', 'An initial U+FEFF is a byte order mark.', 'initial-bom', 'preserve');
      return findingBase(item, 'line-word-format', 'review', 'This invisible character can affect line breaking, word breaking, collation, or searching.', 'contextual-format', 'preserve');
    }
    if (MATH_INVISIBLE.has(cp)) return findingBase(item, 'invisible-math', 'review', 'This character encodes an implied mathematical operation and is intentionally invisible.', 'mathematical-format', 'preserve');
    if (isControl(cp)) return findingBase(item, 'control-code', (context !== 'plain' || [0, 27, 127].includes(cp)) ? 'suspicious' : 'review', 'Non-printing control codes can change parsing or terminal behavior.', 'control', 'remove');
    if (cp !== 0x20 && cp !== 9 && cp !== 10 && cp !== 13 && (inDataRanges(cp, PINNED_DATA && PINNED_DATA.whiteSpace) || matches(RE.whitespace, value))) return findingBase(item, 'unusual-whitespace', context === 'plain' ? 'review' : 'suspicious', 'This spacing character can look like an ordinary space while affecting matching, parsing, or layout.', 'spacing', 'preserve');
    if (BLANK_FILLERS.has(cp)) return findingBase(item, 'blank-filler', context === 'plain' ? 'review' : 'suspicious', 'This assigned character can render as a blank or filler.', 'blank-glyph', 'preserve');
    if (DEPRECATED_FORMAT.has(cp)) return findingBase(item, 'deprecated-format', 'suspicious', 'Unicode deprecates this format control; modern text should not rely on it.', 'deprecated', 'remove');
    if (inDataRanges(cp, PINNED_DATA && PINNED_DATA.defaultIgnorable) || matches(RE.defaultIgnorable, value) || matches(RE.format, value)) return findingBase(item, 'other-default-ignorable', context === 'plain' ? 'review' : 'suspicious', 'This assigned format character is normally hidden in fallback rendering.', 'default-ignorable', 'preserve');
    if (options.includeAdvanced) {
      if (inDataRanges(cp, PINNED_DATA && PINNED_DATA.privateUse) || matches(RE.privateUse, value)) return findingBase(item, 'private-use', 'review', 'Private-use characters have meaning only by private agreement.', 'advanced', 'preserve');
      if (isNoncharacter(cp)) return findingBase(item, 'noncharacter', 'review', 'This code point is permanently reserved as a noncharacter.', 'advanced', 'preserve');
      if ((PINNED_DATA && PINNED_DATA.assigned && !inDataRanges(cp, PINNED_DATA.assigned)) || (!PINNED_DATA && RE.assigned && !matches(RE.assigned, value))) return findingBase(item, 'unassigned', 'review', 'This code point is unassigned in Unicode 17.0.0.', 'advanced', 'preserve');
      if (inDataRanges(cp, PINNED_DATA && PINNED_DATA.marks) || matches(RE.mark, value)) {
        const prev = items[index - 1];
        if (!prev || matches(RE.whitespace, prev.value) || isControl(prev.cp)) return findingBase(item, 'orphan-combining-mark', 'review', 'This combining mark has no preceding graphic base in the inspected text.', 'advanced', 'preserve');
      }
    }
    return null;
  }

  function buildItems(text) {
    const items = [];
    let utf16Offset = 0, line = 1, column = 1;
    for (const value of text) {
      const cp = rawCodePoint(value);
      if (items.length >= MAX_CODE_POINTS) throw new RangeError('Input exceeds 500,000 Unicode code points');
      items.push({ value, cp, utf16Offset, codePointIndex: items.length + 1, line, column });
      utf16Offset += value.length;
      if (cp === 10) { line++; column = 1; } else { column++; }
    }
    return items;
  }

  function analyzeBidi(findings) {
    const byIndex = new Map(findings.map(f => [f.codePointIndex, f]));
    const embeddings = [], isolates = [];
    for (const f of findings.filter(x => x.category === 'bidi-control')) {
      const cp = f.codePointValue;
      if (BIDI_OPEN.has(cp)) {
        embeddings.push(f);
        if (embeddings.length + isolates.length > 125) makeSuspicious(f, 'Directional formatting exceeds the Unicode depth limit.');
      } else if (cp === 0x202C) {
        if (!embeddings.length) makeSuspicious(f, 'Unmatched POP DIRECTIONAL FORMATTING.'); else embeddings.pop();
      } else if (BIDI_ISOLATE.has(cp)) {
        isolates.push(f);
        if (embeddings.length + isolates.length > 125) makeSuspicious(f, 'Directional formatting exceeds the Unicode depth limit.');
      } else if (cp === 0x2069) {
        if (!isolates.length) makeSuspicious(f, 'Unmatched POP DIRECTIONAL ISOLATE.'); else isolates.pop();
      }
    }
    for (const f of embeddings) makeSuspicious(f, 'Directional embedding or override is not terminated before the end of the input.');
    for (const f of isolates) makeSuspicious(f, 'Directional isolate is not terminated before the end of the input.');
    return byIndex;
  }
  function makeSuspicious(f, reason) { f.assessment = 'suspicious'; f.reason = reason; f.contextKind = 'malformed-directional-formatting'; }

  function analyzeTagRuns(items, findings, candidates) {
    const byIndex = new Map(findings.map(f => [f.codePointIndex, f]));
    for (let i = 0; i < items.length;) {
      if (!isTag(items[i].cp)) { i++; continue; }
      const start = i;
      while (i < items.length && isTag(items[i].cp)) i++;
      const run = items.slice(start, i);
      const printable = run.filter(x => inRange(x.cp, 0xE0020, 0xE007E));
      const decoded = printable.map(x => String.fromCodePoint(x.cp - 0xE0000)).join('');
      const prev = items[start - 1];
      const terminated = run.some(x => x.cp === 0xE007F);
      const validEmoji = !!prev && prev.cp === 0x1F3F4 && terminated && RGI_TAGS.has(decoded);
      const ids = [];
      for (const item of run) {
        const f = byIndex.get(item.codePointIndex);
        if (!f) continue;
        ids.push(f.id);
        if (validEmoji) {
          f.assessment = 'expected'; f.reason = 'This tag sequence forms a recognized RGI subdivision flag emoji.'; f.contextKind = 'valid-emoji-tag'; f.cleanupDefault = 'preserve';
        } else {
          f.assessment = 'suspicious'; f.reason = terminated ? 'This tag sequence is not a recognized RGI emoji tag sequence.' : 'This tag sequence is detached or unterminated.'; f.contextKind = 'non-rgi-tag'; f.cleanupDefault = 'remove';
        }
      }
      if (!validEmoji && decoded.length >= 4) candidates.push({ codec: 'unicode-tags-ascii', assessment: 'suspicious', label: 'Possible Unicode Tag payload', decodedText: decoded, escapedBytes: Array.from(decoded).map(c => c.codePointAt(0).toString(16).padStart(2, '0')).join(' '), findingIds: ids, validation: ['non-RGI tag run', 'four or more printable tag characters'] });
    }
  }

  function variationByte(cp) {
    if (inRange(cp, 0xFE00, 0xFE0F)) return cp - 0xFE00;
    if (inRange(cp, 0xE0100, 0xE01EF)) return cp - 0xE0100 + 16;
    return null;
  }
  function analyzeVariationPayload(items, findings, candidates) {
    const relevant = items.filter(x => variationByte(x.cp) !== null);
    if (relevant.length < 4) return;
    const bytes = new Uint8Array(relevant.map(x => variationByte(x.cp)));
    let decoded = null;
    try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (_) {}
    const printableRatio = decoded ? Array.from(decoded).filter(c => /[^\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u.test(c)).length / Math.max(1, Array.from(decoded).length) : 0;
    const byIndex = new Map(findings.map(f => [f.codePointIndex, f]));
    const suspicious = relevant.filter(x => { const f = byIndex.get(x.codePointIndex); return f && f.assessment === 'suspicious'; });
    const supplementRatio = relevant.filter(x => x.cp >= 0xE0100).length / relevant.length;
    if (!(decoded && printableRatio >= 0.85) && !(relevant.length >= 8 && (supplementRatio >= 0.5 || suspicious.length >= relevant.length / 2))) return;
    const payloadFindings = relevant.map(x => byIndex.get(x.codePointIndex)).filter(Boolean);
    for (const finding of payloadFindings) {
      if (finding.assessment === 'expected') continue;
      finding.assessment = 'suspicious';
      finding.reason = 'This selector is part of a byte-like stream that passes the inspector payload validation rules.';
      finding.contextKind = 'selector-byte-payload';
    }
    const ids = payloadFindings.map(f => f.id);
    candidates.push({ codec: 'variation-selector-bytes', assessment: decoded && printableRatio >= 0.85 ? 'review' : 'suspicious', label: 'Possible variation-selector byte payload', decodedText: decoded && printableRatio >= 0.85 ? decoded : null, escapedBytes: Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' '), findingIds: ids, validation: decoded && printableRatio >= 0.85 ? ['valid UTF-8', 'at least 85% printable text'] : ['payload-like selector distribution', 'hex only; text validation failed'] });
  }

  function contextSnippet(items, finding, radius) {
    const index = finding.codePointIndex - 1;
    return items.slice(Math.max(0, index - radius), Math.min(items.length, index + radius + 1)).map(item => {
      const isFinding = item.codePointIndex === finding.codePointIndex;
      const hidden = classify(items, item.codePointIndex - 1, { context: 'plain', includeAdvanced: true });
      const value = hidden ? tokenFor(item.cp) : item.value;
      return isFinding ? '⟦' + value + '⟧' : value;
    }).join('');
  }

  /** Return an escaped, logical-order context window for a finding. */
  function contextFor(text, finding, radius) {
    if (typeof text !== 'string') throw new TypeError('text must be a string');
    if (!finding || !Number.isInteger(finding.codePointIndex)) throw new TypeError('finding is required');
    const items = buildItems(text);
    return contextSnippet(items, finding, Number.isInteger(radius) ? Math.max(0, radius) : 20);
  }

  /** Return the full text with inspected findings replaced by visible tokens. */
  function escapedView(text, report) {
    if (typeof text !== 'string') throw new TypeError('text must be a string');
    const byOffset = new Map((report && report.findings || []).map(f => [f.utf16Offset, f]));
    let output = '', offset = 0;
    for (const value of text) {
      const finding = byOffset.get(offset);
      output += finding ? finding.token : value;
      offset += value.length;
    }
    return output;
  }

  /** Inspect text for invisible and security-sensitive Unicode characters. */
  function inspect(text, options) {
    options = Object.assign({ context: 'plain', includeAdvanced: false, stegzero: null }, options || {});
    if (typeof text !== 'string') throw new TypeError('text must be a string');
    const items = buildItems(text);
    if (items.length > MAX_CODE_POINTS) throw new RangeError('Input exceeds 500,000 Unicode code points');
    const findings = [];
    for (let i = 0; i < items.length; i++) {
      const finding = classify(items, i, options);
      if (finding && (!ADVANCED_CATEGORIES.has(finding.category) || options.includeAdvanced)) findings.push(finding);
    }
    analyzeBidi(findings);
    const candidates = [];
    analyzeTagRuns(items, findings, candidates);
    analyzeVariationPayload(items, findings, candidates);
    const categories = {};
    for (const f of findings) categories[f.category] = (categories[f.category] || 0) + 1;
    const highest = findings.reduce((best, f) => severityRank(f.assessment) > severityRank(best) ? f.assessment : best, 'expected');
    const stegzero = Object.assign({ format: null, status: 'none' }, options.stegzero || {});
    const report = {
      unicodeVersion: DATA_VERSION,
      input: { codePoints: items.length, utf16Units: text.length, lines: text.length ? items[items.length - 1].line : 0 },
      summary: { findingCount: findings.length, distinctCodePoints: new Set(findings.map(f => f.codePoint)).size, categories, highestAssessment: findings.length ? highest : null },
      stegzero,
      findings,
      candidates
    };
    reportSources.set(report, text);
    return report;
  }

  function presetCategories(report, preset) {
    const selected = new Set();
    for (const f of report.findings) {
      if (preset === 'aggressive') selected.add(f.category);
      else if (preset === 'conservative' && f.cleanupDefault === 'remove') selected.add(f.category);
      else if (preset === 'security' && (f.cleanupDefault === 'remove' || f.category === 'bidi-control' || (f.assessment === 'suspicious' && ['unicode-tag','variation-selector','blank-filler','other-default-ignorable'].includes(f.category)))) selected.add(f.category);
    }
    return selected;
  }

  function presetRemovesFinding(finding, preset) {
    if (preset === 'aggressive') return true;
    if (preset === 'conservative') return finding.cleanupDefault === 'remove';
    if (preset === 'security') {
      return finding.cleanupDefault === 'remove' || finding.category === 'bidi-control' ||
        (finding.assessment === 'suspicious' && ['unicode-tag', 'variation-selector', 'blank-filler', 'other-default-ignorable'].includes(finding.category));
    }
    return false;
  }

  /** Produce cleaned text without modifying the inspected source. */
  function clean(text, report, policy) {
    if (typeof text !== 'string' || !report || !Array.isArray(report.findings)) throw new TypeError('Text and an inspection report are required.');
    if ((reportSources.has(report) && reportSources.get(report) !== text) ||
        report.input.utf16Units !== text.length ||
        report.findings.some(f => text.codePointAt(f.utf16Offset) !== f.codePointValue)) {
      throw new Error('The text has changed. Inspect it again before cleaning.');
    }
    policy = Object.assign({ preset: 'conservative', selectedCategories: null, removeStegZero: false }, policy || {});
    const explicitCategories = new Set(policy.selectedCategories || []);
    const selected = policy.preset === 'custom' ? new Set(policy.selectedCategories || []) : presetCategories(report, policy.preset);
    if (Array.isArray(policy.selectedCategories)) for (const c of policy.selectedCategories) selected.add(c);
    const byOffset = new Map(report.findings.map(f => [f.utf16Offset, f]));
    const detailMap = new Map(), changedFindingIds = [];
    let out = '', changes = 0, offset = 0;
    const confirmedStegZero = policy.preset === 'security' && report.stegzero && report.stegzero.status === 'decoded';
    const stegzeroSet = (policy.removeStegZero || confirmedStegZero) ? new Set(['\u200B','\u200C','\u200D','\u2060','\u2062','\u2063','\u2064','\uFEFF']) : null;
    for (const value of text) {
      const f = byOffset.get(offset);
      let replace = null;
      const explicitlySelected = explicitCategories.has(f && f.category);
      const presetSelected = f && policy.preset !== 'custom' && presetRemovesFinding(f, policy.preset);
      const customSelected = f && policy.preset === 'custom' && selected.has(f.category);
      if (f && (explicitlySelected || presetSelected || customSelected)) {
        if (f.category === 'unusual-whitespace' && policy.preset === 'aggressive') replace = (f.codePointValue === 0x2028 || f.codePointValue === 0x2029) ? '\n' : ' ';
        else replace = '';
      } else if (stegzeroSet && stegzeroSet.has(value)) replace = '';
      if (replace !== null) {
        out += replace;
        changes++;
        if (f) changedFindingIds.push(f.id);
        const codePointValue = value.codePointAt(0);
        const action = replace === '' ? 'remove' : 'replace';
        const category = f ? f.category : 'stegzero-carrier';
        const key = [action, category, codePointValue, replace].join('|');
        if (!detailMap.has(key)) detailMap.set(key, {
          action,
          category,
          token: f ? f.token : tokenFor(codePointValue),
          codePoint: f ? f.codePoint : cpText(codePointValue),
          replacement: replace,
          count: 0,
          findingIds: []
        });
        const detail = detailMap.get(key);
        detail.count++;
        if (f) detail.findingIds.push(f.id);
      } else out += value;
      offset += value.length;
    }
    return {
      text: out,
      changes,
      selectedCategories: Array.from(selected),
      changeDetails: Array.from(detailMap.values()),
      changedFindingIds
    };
  }

  function formatReport(report, format) {
    if (format === 'json') return JSON.stringify(report, null, 2);
    const lines = [
      'StegZero Unicode inspection report',
      'Unicode data: ' + report.unicodeVersion,
      'Code points: ' + report.input.codePoints,
      'UTF-16 units: ' + report.input.utf16Units,
      'Findings: ' + report.summary.findingCount,
      'Assessment: ' + (report.summary.highestAssessment || 'none'),
      'StegZero: ' + (report.stegzero.format || 'not detected'),
      ''
    ];
    for (const f of report.findings) lines.push(`${f.codePointIndex}. ${f.token} ${f.codePoint} ${f.name} | ${f.category} | ${f.assessment} | line ${f.line}, column ${f.column}, UTF-16 ${f.utf16Offset} | ${f.reason}`);
    for (const c of report.candidates) lines.push(`\n${c.label}: ${c.decodedText || c.escapedBytes}`);
    return lines.join('\n');
  }

  root.StegZeroUnicode = Object.freeze({ DATA_VERSION, MAX_CODE_POINTS, inspect, clean, formatReport, tokenFor, escapedView, contextFor });
})(typeof window !== 'undefined' ? window : globalThis);

// Node/CommonJS adapter for the CLI. Browser behavior is unchanged because
// `module` is undefined when this file loads as a classic script.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).StegZeroUnicode;
}
