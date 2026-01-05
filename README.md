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

This section describes the current "v2" format that the app writes and reads.

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

- **Legacy fallback**
    - For older texts, there is a legacy mode that treats two zero‑width
        characters as raw 0/1 bits without headers, then attempts to interpret the
        resulting bytes as UTF‑8.

---

## Using the Web App

1. Open the main page at https://stegzero.com.
2. In the **Visible text** area, type or paste the text that should appear normal.
3. In the **Secret message** area, enter the content you want to hide.
4. Click **Encode** to generate text containing the hidden message.
5. Use the **Copy** button to place the encoded text on your clipboard and
    share it anywhere you would share normal text (chat, email, docs, etc.).
6. To decode, paste any suspicious or previously encoded text into the
    **Input / Encoded text** area and click **Decode** to reveal the message.

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
- Font Awesome icons (CDN)

There is no build step; everything is plain static assets.

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

