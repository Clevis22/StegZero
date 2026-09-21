'use strict';

const { parseArgs } = require('node:util');
const engines = require('./node-engines.js');
const { detectPayload } = require('./detection.js');
const io = require('./io.js');
const { CliError, EXIT } = require('./errors.js');

const { protocol, unicode } = engines;
const VERSION = require('../package.json').version;

const MODES = ['standard', 'compatibility'];
const FORMATS = ['text', 'json'];
const CONTEXTS = ['plain', 'source', 'identifier'];
const PRESETS = ['conservative', 'security', 'aggressive'];
const WATERMARK_TYPES = ['text', 'html', 'xml', 'json', 'csv'];

const REVEAL_ERRORS = {
  NO_PAYLOAD: 'No StegZero payload was found.',
  PASSPHRASE_REQUIRED: 'This StegZero message requires a passphrase.',
  PASSPHRASE_MISMATCH: 'The supplied passphrase did not verify.',
  DAMAGED_PAYLOAD: 'A StegZero frame was found but appears damaged or truncated.',
  UNVERIFIED_PAYLOAD: 'A possible legacy payload was found but could not be verified.'
};

const HELP = `StegZero command-line interface

Usage:
  stegzero hide [options]
  stegzero reveal [file] [options]
  stegzero inspect [file] [options]
  stegzero clean [file] [options]
  stegzero watermark add <file> [options]
  stegzero watermark check [file] [options]
  stegzero help
  stegzero --version

Commands:
  hide                Hide a message in visible cover text.
  reveal              Detect and decode a StegZero payload.
  inspect             Inspect text for invisible and suspicious Unicode.
  clean               Write a cleaned copy using the inspector policies.
  watermark add       Embed a watermark ID into a structured file.
  watermark check     Read a watermark ID from a file.

Common input/output:
  Files are read and written as UTF-8 (BOM-marked UTF-16 is also accepted).
  Payload output goes to stdout; diagnostics go to stderr.
  Existing output files are protected unless --force is supplied.

Passphrases:
  Use --passphrase-file <path> or --prompt-passphrase. Passphrases are
  obfuscation and mismatch detection, not encryption.

Exit codes:
  0  success
  1  no payload/watermark, or inspect found review/suspicious findings
  2  invalid usage or conflicting arguments
  3  input/output filesystem failure
  4  passphrase required or the supplied passphrase failed verification
  5  recognized but malformed, truncated, oversized, or invalid data

Run "stegzero <command> help" for command details.`;

const COMMAND_HELP = {
  hide: `stegzero hide

Required (exactly one cover source and one message source):
  --cover <text>              Visible cover text
  --cover-file <path>         Read cover text from a file
  --message <text>            Hidden message
  --message-file <path>       Read the hidden message from a file
  If the message is omitted, it is read from stdin. If the cover is omitted
  and the message is supplied, the cover is read from stdin.

Options:
  --mode <standard|compatibility>   Default: standard
  --passphrase-file <path>          Read a passphrase from a file
  --prompt-passphrase               Prompt securely on a TTY
  --output <path>                   Write encoded text to a file
  --force                           Overwrite an existing output file`,

  reveal: `stegzero reveal [file]

Reads the encoded text from <file> or stdin.

Options:
  --passphrase-file <path>   Read a passphrase from a file
  --prompt-passphrase        Prompt securely on a TTY
  --format <text|json>       Default: text
  --output <path>            Write the result to a file
  --force                    Overwrite an existing output file`,

  inspect: `stegzero inspect [file]

Reads the text from <file> or stdin.

Options:
  --context <plain|source|identifier>   Default: plain
  --advanced                            Include advanced Unicode anomalies
  --format <text|json>                  Default: text
  --output <path>                       Write the report to a file
  --force                               Overwrite an existing output file

Exits with code 1 when the report contains review or suspicious findings.`,

  clean: `stegzero clean [file]

Reads the text from <file> or stdin.

Options:
  --preset <conservative|security|aggressive>   Default: conservative
  --context <plain|source|identifier>
  --advanced
  --remove-stegzero                 Remove confirmed StegZero carriers
  --output <path>                   Write the cleaned text to a file
  --in-place                        Replace the input file atomically
  --force                           Overwrite an existing output file`,

  'watermark add': `stegzero watermark add <file>

Options:
  --id <text>            Watermark identifier (exactly one of --id/--id-file)
  --id-file <path>       Read the identifier from a file
  --type <text|html|xml|json|csv>   Override extension detection
  --output <path>        Write the watermarked file (or use --in-place)
  --in-place             Replace the input file atomically
  --force                Overwrite an existing output file`,

  'watermark check': `stegzero watermark check [file]

Reads the file from <file> or stdin.

Options:
  --format <text|json>   Default: text
  --output <path>        Write the result to a file
  --force                Overwrite an existing output file`
};

function usage(message) {
  return new CliError(EXIT.USAGE, 'EUSAGE', message);
}

function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw usage(`Invalid ${label} "${value}". Expected one of: ${allowed.join(', ')}.`);
  }
  return value;
}

function parseCommandArgs(args, options) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw usage(error.message.replace(/^.*?:\s*/, ''));
  }
}

function rethrowEngineError(error, code) {
  if (error instanceof CliError) throw error;
  throw new CliError(EXIT.INVALID_DATA, code, error && error.message ? error.message : String(error));
}

async function resolvePassphrase(values) {
  const hasFile = values['passphrase-file'] != null;
  const hasPrompt = !!values['prompt-passphrase'];
  if (hasFile && hasPrompt) {
    throw usage('Use either --passphrase-file or --prompt-passphrase, not both.');
  }
  let passphrase = null;
  if (hasFile) passphrase = await io.readSecretFile(values['passphrase-file']);
  if (hasPrompt) passphrase = await io.promptPassphrase('Passphrase: ');
  if (passphrase !== null && passphrase.length === 0) {
    throw usage('The passphrase cannot be empty.');
  }
  return passphrase;
}

async function readInput(positional, label) {
  return positional ? await io.readTextFile(positional) : await io.readStdin(label);
}

function revealExitCode(detection) {
  switch (detection.status) {
    case 'decoded': return detection.verified ? EXIT.OK : EXIT.NO_RESULT;
    case 'passphrase-required':
    case 'passphrase-mismatch': return EXIT.PASSPHRASE;
    case 'damaged': return EXIT.INVALID_DATA;
    default: return EXIT.NO_RESULT;
  }
}

function revealWarning(detection) {
  if (detection.status !== 'decoded' || detection.verified) return null;
  if (detection.format === 'legacy') {
    return 'Warning: possible legacy text decoded, but this unframed format has no signature or checksum and may be a false positive.';
  }
  return 'Warning: older passphrase payload decoded, but this format cannot verify whether the passphrase is correct.';
}

async function cmdHide(args) {
  const { values, positionals } = parseCommandArgs(args, {
    cover: { type: 'string' },
    'cover-file': { type: 'string' },
    message: { type: 'string' },
    'message-file': { type: 'string' },
    mode: { type: 'string' },
    'passphrase-file': { type: 'string' },
    'prompt-passphrase': { type: 'boolean' },
    output: { type: 'string' },
    force: { type: 'boolean' }
  });
  if (positionals.length) throw usage('hide does not accept positional arguments.');

  const coverCount = Number(values.cover != null) + Number(values['cover-file'] != null);
  const messageCount = Number(values.message != null) + Number(values['message-file'] != null);
  if (coverCount > 1) throw usage('Provide only one of --cover or --cover-file.');
  if (messageCount > 1) throw usage('Provide only one of --message or --message-file.');
  if (coverCount === 0 && messageCount === 0) {
    throw usage('A cover source is required: use --cover or --cover-file.');
  }

  let cover = values.cover != null ? values.cover : values['cover-file'] != null ? await io.readTextFile(values['cover-file']) : undefined;
  let message;
  if (messageCount === 1) {
    message = values.message != null ? values.message : await io.readTextFile(values['message-file']);
    if (cover === undefined) cover = await io.readStdin('cover');
  } else {
    message = await io.readStdin('message');
  }
  if (message.length === 0) throw usage('The hidden message cannot be empty.');

  const mode = oneOf(values.mode || 'standard', MODES, 'mode');
  const passphrase = await resolvePassphrase(values);

  let encoded;
  try {
    encoded = mode === 'standard'
      ? protocol.encodeMsg(cover, message, passphrase)
      : protocol.encodeMsgBinary(cover, message, passphrase);
  } catch (error) {
    rethrowEngineError(error, 'ENCODE_FAILED');
  }

  await io.writeOutput(encoded, values.output, { force: !!values.force });
  return EXIT.OK;
}

async function cmdReveal(args) {
  const { values, positionals } = parseCommandArgs(args, {
    'passphrase-file': { type: 'string' },
    'prompt-passphrase': { type: 'boolean' },
    format: { type: 'string' },
    output: { type: 'string' },
    force: { type: 'boolean' }
  });
  if (positionals.length > 1) throw usage('reveal accepts at most one input path.');

  const text = await readInput(positionals[0], 'encoded input');
  const passphrase = await resolvePassphrase(values);
  const detection = detectPayload(text, passphrase, engines);
  const format = oneOf(values.format || 'text', FORMATS, 'format');
  const exitCode = revealExitCode(detection);

  if (format === 'json') {
    const payload = detection.status === 'decoded'
      ? { ok: true, format: detection.format, verified: detection.verified, message: detection.message }
      : { ok: false, code: detection.code, error: REVEAL_ERRORS[detection.code] || 'The payload could not be decoded.' };
    await io.writeOutput(JSON.stringify(payload) + '\n', values.output, { force: !!values.force });
    return exitCode;
  }

  if (detection.status === 'decoded') {
    const warning = revealWarning(detection);
    if (warning) process.stderr.write(warning + '\n');
    await io.writeOutput(detection.message, values.output, { force: !!values.force });
    return exitCode;
  }

  process.stderr.write((REVEAL_ERRORS[detection.code] || 'No payload was found.') + '\n');
  return exitCode;
}

async function buildInspection(text) {
  const detection = detectPayload(text, null, engines);
  return detection;
}

async function cmdInspect(args) {
  const { values, positionals } = parseCommandArgs(args, {
    context: { type: 'string' },
    advanced: { type: 'boolean' },
    format: { type: 'string' },
    output: { type: 'string' },
    force: { type: 'boolean' }
  });
  if (positionals.length > 1) throw usage('inspect accepts at most one input path.');

  const context = oneOf(values.context || 'plain', CONTEXTS, 'context');
  const format = oneOf(values.format || 'text', FORMATS, 'format');
  const text = await readInput(positionals[0], 'input');
  const detection = await buildInspection(text);

  let report;
  try {
    report = unicode.inspect(text, {
      context,
      includeAdvanced: !!values.advanced,
      stegzero: { format: detection.format, status: detection.status }
    });
  } catch (error) {
    rethrowEngineError(error, 'INSPECT_FAILED');
  }

  const output = format === 'json'
    ? unicode.formatReport(report, 'json') + '\n'
    : unicode.formatReport(report, 'text') + '\n';
  await io.writeOutput(output, values.output, { force: !!values.force });

  const needsAttention = report.findings.some(f => f.assessment === 'review' || f.assessment === 'suspicious');
  return needsAttention ? EXIT.NO_RESULT : EXIT.OK;
}

async function cmdClean(args) {
  const { values, positionals } = parseCommandArgs(args, {
    preset: { type: 'string' },
    context: { type: 'string' },
    advanced: { type: 'boolean' },
    'remove-stegzero': { type: 'boolean' },
    output: { type: 'string' },
    'in-place': { type: 'boolean' },
    force: { type: 'boolean' }
  });
  if (positionals.length > 1) throw usage('clean accepts at most one input path.');
  const inPlace = !!values['in-place'];
  if (inPlace && !positionals[0]) throw usage('--in-place requires an input file path.');
  if (inPlace && values.output) throw usage('--in-place cannot be combined with --output.');

  const preset = oneOf(values.preset || 'conservative', PRESETS, 'preset');
  const context = oneOf(values.context || 'plain', CONTEXTS, 'context');
  const text = await readInput(positionals[0], 'input');
  const detection = await buildInspection(text);

  let report;
  let result;
  try {
    report = unicode.inspect(text, {
      context,
      includeAdvanced: !!values.advanced,
      stegzero: { format: detection.format, status: detection.status }
    });
    result = unicode.clean(text, report, { preset, removeStegZero: !!values['remove-stegzero'] });
  } catch (error) {
    rethrowEngineError(error, 'CLEAN_FAILED');
  }

  if (inPlace) {
    await io.writeFileAtomic(positionals[0], result.text);
    process.stderr.write(`${result.changes} change${result.changes === 1 ? '' : 's'} written to ${positionals[0]}\n`);
    return EXIT.OK;
  }
  if (values.output) {
    await io.writeOutput(result.text, values.output, { force: !!values.force });
    process.stderr.write(`${result.changes} change${result.changes === 1 ? '' : 's'} written to ${values.output}\n`);
    return EXIT.OK;
  }
  await io.writeOutput(result.text, null);
  return EXIT.OK;
}

async function cmdWatermarkAdd(args) {
  const { values, positionals } = parseCommandArgs(args, {
    id: { type: 'string' },
    'id-file': { type: 'string' },
    type: { type: 'string' },
    output: { type: 'string' },
    'in-place': { type: 'boolean' },
    force: { type: 'boolean' }
  });
  if (positionals.length !== 1) throw usage('watermark add requires exactly one input file.');
  const inputPath = positionals[0];
  const inPlace = !!values['in-place'];
  if (inPlace && values.output) throw usage('--in-place cannot be combined with --output.');
  if (!inPlace && !values.output) throw usage('watermark add requires --output or --in-place.');

  const idCount = Number(values.id != null) + Number(values['id-file'] != null);
  if (idCount !== 1) throw usage('Provide exactly one of --id or --id-file.');
  const id = values.id != null ? values.id : await io.readSecretFile(values['id-file']);
  if (id.length === 0) throw usage('The watermark ID cannot be empty.');

  const text = await io.readTextFile(inputPath);
  const fileType = values.type != null ? oneOf(values.type, WATERMARK_TYPES, 'type') : protocol.getFileType(inputPath);

  let watermarked;
  try {
    watermarked = protocol.wmEncode(text, id, fileType);
  } catch (error) {
    rethrowEngineError(error, 'WATERMARK_FAILED');
  }

  if (inPlace) {
    await io.writeFileAtomic(inputPath, watermarked);
  } else {
    await io.writeOutput(watermarked, values.output, { force: !!values.force });
  }
  return EXIT.OK;
}

async function cmdWatermarkCheck(args) {
  const { values, positionals } = parseCommandArgs(args, {
    format: { type: 'string' },
    output: { type: 'string' },
    force: { type: 'boolean' }
  });
  if (positionals.length > 1) throw usage('watermark check accepts at most one input path.');

  const format = oneOf(values.format || 'text', FORMATS, 'format');
  const text = await readInput(positionals[0], 'input');
  let id = null;
  try {
    id = protocol.wmDecode(text);
  } catch (error) {
    rethrowEngineError(error, 'WATERMARK_FAILED');
  }

  if (format === 'json') {
    const payload = id !== null
      ? { ok: true, watermarked: true, id }
      : { ok: false, watermarked: false, code: 'NO_WATERMARK', error: 'No StegZero watermark was found.' };
    await io.writeOutput(JSON.stringify(payload) + '\n', values.output, { force: !!values.force });
    return id !== null ? EXIT.OK : EXIT.NO_RESULT;
  }

  if (id !== null) {
    await io.writeOutput(id + '\n', values.output, { force: !!values.force });
    return EXIT.OK;
  }
  process.stderr.write('No StegZero watermark was found.\n');
  return EXIT.NO_RESULT;
}

function printHelp(topic) {
  if (topic && COMMAND_HELP[topic]) {
    process.stdout.write(COMMAND_HELP[topic] + '\n');
    return EXIT.OK;
  }
  if (topic) throw usage(`Unknown help topic "${topic}".`);
  process.stdout.write(HELP + '\n');
  return EXIT.OK;
}

async function dispatch(args) {
  if (args.length === 0) return printHelp();
  const command = args[0];
  if (command === '--version' || command === '-v') {
    process.stdout.write(VERSION + '\n');
    return EXIT.OK;
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    return printHelp(args[1]);
  }
  const helpRequested = value => value === 'help' || value === '--help' || value === '-h';
  if (['hide', 'reveal', 'inspect', 'clean'].includes(command) && helpRequested(args[1])) {
    if (args.length > 2) throw usage(`Unexpected argument "${args[2]}" after help.`);
    return printHelp(command);
  }
  switch (command) {
    case 'hide': return await cmdHide(args.slice(1));
    case 'reveal': return await cmdReveal(args.slice(1));
    case 'inspect': return await cmdInspect(args.slice(1));
    case 'clean': return await cmdClean(args.slice(1));
    case 'watermark': {
      const sub = args[1];
      if ((sub === 'add' || sub === 'check') && helpRequested(args[2])) {
        if (args.length > 3) throw usage(`Unexpected argument "${args[3]}" after help.`);
        return printHelp(`watermark ${sub}`);
      }
      if (sub === 'add') return await cmdWatermarkAdd(args.slice(2));
      if (sub === 'check') return await cmdWatermarkCheck(args.slice(2));
      if (sub === 'help' || sub === undefined) return printHelp('watermark add');
      throw usage('watermark requires the "add" or "check" subcommand.');
    }
    default:
      throw usage(`Unknown command "${command}". Run "stegzero help".`);
  }
}

async function run(argv = process.argv) {
  try {
    return await dispatch(argv.slice(2));
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(error.message + '\n');
      return error.exitCode;
    }
    process.stderr.write(`Unexpected error: ${error && error.stack ? error.stack : String(error)}\n`);
    return EXIT.NO_RESULT;
  }
}

module.exports = { run, HELP };
