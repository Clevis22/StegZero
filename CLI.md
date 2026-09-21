# StegZero CLI

A dependency-light Node.js command line interface that exposes StegZero's message
codec, Unicode inspector, cleanup policies, and file-watermarking features. It
uses the same implementation and wire formats as the website, so messages and
watermarks are interchangeable between the two.

## Installation

Install the CLI directly from GitHub:

```bash
npm install --global github:Clevis22/StegZero
stegzero --version
```

For a local checkout:

```bash
npm link
stegzero --version
```

Or run it directly without installing:

```bash
node bin/stegzero.js --version
```

Node versions are defined by `package.json` (`engines.node`).

## Commands

```text
stegzero hide
stegzero reveal
stegzero inspect
stegzero clean
stegzero watermark add
stegzero watermark check
stegzero help
stegzero --version
```

Run `stegzero <command> help` for command-specific options.

## Examples

### Hide and reveal

```bash
stegzero hide --cover "Meet me at noon" --message "Use the east entrance"
stegzero hide --cover-file cover.txt --message-file secret.txt --output encoded.txt
printf 'secret' | stegzero hide --cover "Visible text"
cat encoded.txt | stegzero reveal
stegzero reveal encoded.txt --format json
```

### Passphrases

```bash
stegzero hide --cover "Visible" --message "Secret" --passphrase-file passphrase.txt
stegzero reveal encoded.txt --prompt-passphrase
```

A passphrase file loses exactly one final `\n` or `\r\n`. Use
`--passphrase-file` or `--prompt-passphrase`; there is deliberately no
`--passphrase <value>` option because it would expose the passphrase through
shell history and process listings. Passphrases cannot be empty.

### Inspect and clean

```bash
stegzero inspect suspicious.txt
stegzero inspect source.js --context source --advanced
cat suspicious.txt | stegzero inspect --format json

stegzero clean suspicious.txt --preset conservative
stegzero clean source.js --preset security --output source.cleaned.js
stegzero clean input.txt --preset aggressive --in-place
```

### Watermarks

```bash
stegzero watermark add report.md --id "release-42" --output report.marked.md
stegzero watermark add data.json --id "build-123" --in-place
stegzero watermark check report.marked.md
stegzero watermark check data.json --format json
```

Watermark IDs cannot be empty.

## Stdin and stdout behavior

- Payload output (encoded text, decoded text, watermark ID) goes to stdout.
- Diagnostics, warnings, and change summaries go to stderr.
- Encoded and decoded text written to stdout never includes labels, color, or
  trailing explanatory lines, so commands are safe in pipelines.
- Files are read and written as UTF-8. BOM-marked UTF-16 files are also accepted.
- Newlines, Unicode, and whitespace are not silently normalized.
- Existing output files are protected unless `--force` or `--in-place` is used.
- Broken pipes (for example `stegzero inspect file | head`) exit cleanly.

## Input source rules for `hide`

- Exactly one cover source and one message source are required.
- Stdin may supply either the cover or the message, but not both.
- If the message is omitted, stdin is the message source.
- Ambiguous combinations are rejected instead of guessed.

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | Command completed successfully; inspect found no review/suspicious findings. |
| `1` | Valid operation with a negative result: no payload/watermark, or inspect found review/suspicious findings. |
| `2` | Invalid CLI usage or conflicting arguments. |
| `3` | Input/output filesystem failure. |
| `4` | Recognized payload requires a passphrase or the supplied passphrase failed verification. |
| `5` | Recognized but malformed, truncated, oversized, or otherwise invalid data. |

JSON failures include a machine-readable code such as `NO_PAYLOAD`,
`PASSPHRASE_REQUIRED`, `PASSPHRASE_MISMATCH`, `DAMAGED_PAYLOAD`, or
`UNVERIFIED_PAYLOAD`.

## CI example

`inspect` exits `1` when it finds review or suspicious characters, so it works as
a CI gate:

```bash
stegzero inspect src/config.js --context source --format json > unicode-report.json
```

## Security

StegZero passphrases provide obfuscation and mismatch detection, not encryption.
They do not protect a message from a determined attacker.

Current limits are unchanged from the website: at most 500,000 Unicode code
points in encoded output, and at most 65,535 encoded bytes (including passphrase
metadata) in a hidden message.
