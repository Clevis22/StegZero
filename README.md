# StegZero

StegZero is a free, browser‑based zero‑width Unicode steganography tool.
It hides short messages inside otherwise normal‑looking text by inserting
invisible characters such as ZWSP, ZWNJ, and ZWJ. Everything runs client‑side
in your browser; no data is sent to a server.

Live site: https://stegzero.com

---

## Features

- Encode hidden messages into normal‑looking text
- Decode / reveal hidden messages from pasted text
- Inspect invisible, formatting, directional, and suspicious Unicode using pinned Unicode 17.0 data
- Preview conservative, security-focused, or aggressive cleanup without changing the source input
- Inspect one local UTF-8 or BOM-marked UTF-16 text/code file entirely in the browser
- Copy encoded or decoded text with a single click
- 100% client‑side (no accounts, no backend)
- Modern, responsive UI

---

## How It Works (Conceptually)

- The tool inserts invisible zero‑width Unicode characters into your text.
- Different patterns of those characters represent bits of your secret message.
- To a casual reader, the text looks unchanged, but the hidden data can be
     recovered by a compatible decoder (like this app).

> This is **obfuscation**, not cryptography: it hides that a message exists,
> but does not strongly protect its contents.

---

## How It Works (Under the Hood)

The shared engine in `stegzero-protocol.js` reads and writes Standard and Compatibility frames. “v2” is the historical name for Standard mode, not the version byte inside its header.

- **Message → bytes → bits**
    - Your secret message is encoded as UTF‑8 bytes so any Unicode text is supported.
    - Those bytes are turned into a bit string (8 bits per byte).

- **Structured header**
    - Before the payload, StegZero prepends an 11‑byte header:
        - 2 bytes: magic value to detect valid v2 payloads
        - 1 byte: format version
        - 2 bytes: random 16‑bit nonce
        - 2 bytes: message length in bytes
        - 4 bytes: CRC32 of the message bytes
    - The header is stored in clear (not obfuscated) so the decoder can quickly
        detect whether a message is present and how long it should be.

- **Bit obfuscation (not encryption)**
    - Only the message bits (not the header) go through a simple xorshift32
        pseudo‑random generator, seeded from the nonce and magic.
    - Each payload bit is XORed with a pseudo‑random bit; this makes the pattern
        of bits less regular but is **not** meant as strong encryption.

- **Mapping bits to zero‑width characters**
    - The combined header + payload bits are grouped into 3‑bit chunks.
    - Each 3‑bit chunk (0–7) is mapped to one of eight zero‑width/invisible
        Unicode code points (a small alphabet that includes ZWSP, ZWNJ, ZWJ, etc.).
    - This yields a sequence of invisible characters that carries all the bits.

- **Interleaving into the visible text**
    - The zero‑width payload is evenly interleaved through the visible text,
        inserting a few invisible characters after each visible character instead
        of tacking everything onto the end.
    - If there is no visible text, the payload is still valid but appears as a
        run of invisible characters.

- **Decoding path**
    - The decoder scans the text and keeps only characters from the zero‑width
        alphabet, then maps them back to 3‑bit chunks.
    - It reads the first 11 bytes as a header, checks the magic, version, and
        declared length, and uses the nonce to derive the same PRNG seed.
    - The next `length × 8` bits are de‑obfuscated with the PRNG, turned into
        bytes, and validated with the stored CRC32.
    - If everything checks out, the bytes are decoded as UTF‑8 to recover your
        original message.

- **Compatibility mode**
    - Uses the same 11-byte header layout with magic `0xB100`, instead of Standard's `0xA55A`.
    - Stores one bit per character using ZWSP and ZWNJ; Standard stores three bits per character.

- **Passphrase versions**
    - Unprotected frames use version 1. New passphrase frames use version 3, with a 12-byte wrapper containing a marker, a checksum of the full passphrase, and a checksum of the plaintext, followed by repeating-key XOR.
    - The decoder retains support for older version 1 and version 2 passphrase messages.
    - These checks detect mismatches; they are not cryptographic authentication or encryption.

- **Size and preview limits**
    - A frame holds at most 65,535 payload bytes, including passphrase metadata.
    - New encoded messages must also fit within the inspector's 500,000-code-point limit, including cover text. Compatibility mode therefore reaches its limit sooner.
    - The visual preview shows at most 2,000 code points. Copying and downloading retain the full encoded result.

- **Legacy fallback**
    - For older texts, there is a legacy mode that treats two zero‑width
        characters as raw 0/1 bits without headers, then attempts to interpret the
        resulting bytes as UTF‑8.

---

## File watermarking

- Plain text and Markdown retain distributed Standard zero-width watermarks.
- HTML uses a comment before the document; XML places the comment after its declaration, if present. Script, style, and element content are preserved.
- JSON uses a Standard frame mapped to spaces and tabs on a final whitespace line. The original contents remain intact and the parsed JSON value is unchanged. Check watermark recognizes this trailer and still reads older zero-width watermarks. Older StegZero releases cannot read the new JSON whitespace trailer.
- CSV inserts the watermark inside an existing field, respecting quotes, escaped quotes, and embedded newlines. It prefers a nonnumeric text field. Field content contains invisible characters; numeric-only files use the first field, so consumers must remove the watermark before treating that field as a number.
- Invalid JSON and malformed CSV are rejected. Formatting, minification, or whitespace trimming can remove watermarks; verify the copy after transfer.

## Using the Web App

1. Open the main page at https://stegzero.com.
2. In the **Visible text** area, type or paste the text that should appear normal.
3. In the **Message to hide** area, enter the content you want to hide.
4. Click **Hide message** to generate text containing the hidden message.
5. Use the **Copy** button to place the encoded text on your clipboard and
    share it anywhere you would share normal text (chat, email, docs, etc.).
6. To decode, paste any suspicious or previously encoded text into the
    **Text to inspect** area and click **Reveal message** to reveal the message.

Error states and basic validation (empty inputs, oversized text, etc.) are
handled in‑browser and surfaced via inline messages.

---

## Running Locally

StegZero is a static site; you can run it directly or via any static server.

**Option 1 – Open index.html directly**

1. Clone or download this repository.
2. Open `index.html` in a modern browser (Chrome, Firefox, Edge, Safari).

**Option 2 – Simple local server (recommended for development)**

From the project root:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/` in your browser.

---

## Technology

- HTML
- CSS (no framework)
- Vanilla JavaScript

There is no build step; everything deployed is plain static assets. The protocol engine is shared by the page and its tests. Development-only DOM tests use jsdom; no npm dependencies are loaded by the site.

### Unicode inspector development

The Unicode scanner is a dependency-free browser global in `unicode-inspector.js`:

```js
StegZeroUnicode.inspect(text, { context: 'plain', includeAdvanced: false });
StegZeroUnicode.clean(text, report, { preset: 'conservative' });
StegZeroUnicode.formatReport(report, 'json');
```

The generated `unicode-inspector-data.js` bundle is pinned to Unicode 17.0.0. To update or verify it, run:

```bash
npm run generate:unicode
```

The generator downloads only version-pinned official Unicode data files, checks every SHA-256 digest, and refuses unexpected content. The deployed scanner performs no runtime data fetches. Run the automated tests with:

```bash
npm ci
npm test
```

The suite covers protocol compatibility, output limits, structured-file watermarking, cleanup policies, and DOM interactions on both pages. Use Node.js 22.22.2+, 24.15.0+, or 26+.

### Command-line interface

The same encoding, decoding, Unicode inspection, cleanup, and file-watermarking
features are available from a terminal:

```bash
npm install --global github:Clevis22/StegZero
stegzero --help
stegzero hide --cover "Visible text" --message "Hidden message"
```

See [CLI.md](CLI.md) for installation, commands, pipeline behavior, and exit
codes. The package remains private and is not published to npm.

---

## Security & Privacy

- Zero‑width steganography **does not provide strong security**.
- Anyone who suspects steganography and uses the right tooling can likely
   detect or extract the hidden data.
- Do **not** use this project to protect sensitive, personal, or regulated data.
- All processing happens locally in your browser; nothing is uploaded.

This project is intended for education, experimentation, and demos.

---

## License

This project is licensed under the GNU Affero General Public License v3.0.

---

## Support

If you find StegZero useful, you can support its development by:

- Sponsoring on GitHub: https://github.com/sponsors/Clevis22
- Starring the repository: https://github.com/Clevis22/StegZero
