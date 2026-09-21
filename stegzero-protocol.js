// Shared classic-script protocol engine. Keep existing wire formats decodable.
const MAX_ENCODED_CODE_POINTS = 500000;
const ZW_ALPHABET = ['\u200B','\u200C','\u200D','\u2060','\u2062','\u2063','\u2064','\uFEFF'];
const LEGACY_0 = '\u200B', LEGACY_1 = '\u200C';
const MAGIC = 0xA55A, VERSION = 1, PASSPHRASE_VERSION = 2, PASSPHRASE_BOUND_VERSION = 3;
const PASSPHRASE_MARKER = new Uint8Array([0x53, 0x5A, 0x50, 0x32]); // "SZP2" (legacy authenticated wrapper)
const PASSPHRASE_BOUND_MARKER = new Uint8Array([0x53, 0x5A, 0x50, 0x33]); // "SZP3" (binds the full passphrase)
const te = new TextEncoder(), td = new TextDecoder();
function bytesToBits(b){let s='';for(let i=0;i<b.length;i++)s+=b[i].toString(2).padStart(8,'0');return s;}
function bitsToBytes(s){const o=[];for(let i=0;i+8<=s.length;i+=8)o.push(parseInt(s.slice(i,i+8),2));return new Uint8Array(o);}
const CRC_TABLE=(()=>{const t=new Uint32Array(256);for(let i=0;i<256;i++){let c=i;for(let k=0;k<8;k++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);t[i]=c>>>0;}return t;})();
function crc32(b){let c=0xFFFFFFFF>>>0;for(let i=0;i<b.length;i++)c=CRC_TABLE[(c^b[i])&0xFF]^(c>>>8);return(c^0xFFFFFFFF)>>>0;}
function numToBytesBE(n,l){const o=new Uint8Array(l);for(let i=l-1;i>=0;i--){o[i]=n&0xFF;n>>>=8;}return o;}
function concatBytes(...a){const t=a.reduce((s,x)=>s+x.length,0),o=new Uint8Array(t);let off=0;for(const x of a){o.set(x,off);off+=x.length;}return o;}
function xorshift32(seed){let x=seed>>>0;return()=>{if(x===0)x=0x9E3779B9;x^=x<<13;x>>>=0;x^=x>>>17;x>>>=0;x^=x<<5;x>>>=0;return x>>>0;};}
function obfuscateBits(bits,seed){const next=xorshift32(seed);let acc=0,remain=0,out='';for(let i=0;i<bits.length;i++){if(remain===0){acc=next();remain=32;}const p=acc&1;acc>>>=1;remain--;out+=((bits.charCodeAt(i)&1)^p)?'1':'0';}return out;}
function bitsToAlphabet(bits){let out='';for(let i=0;i<bits.length;i+=3){const ch=bits.slice(i,i+3).padEnd(3,'0');out+=ZW_ALPHABET[parseInt(ch,2)];}return out;}
function alphabetToBits(str){const map=new Map(ZW_ALPHABET.map((ch,i)=>[ch,i]));let bits='';for(const ch of Array.from(str)){if(map.has(ch))bits+=map.get(ch).toString(2).padStart(3,'0');}return bits;}
function buildHeader(nonce,msgBytes,version=VERSION,magic=MAGIC){const len=msgBytes.length;if(len>0xFFFF)throw new RangeError('The hidden message is too large. StegZero supports at most 65,535 encoded bytes, including passphrase metadata.');const crc=crc32(msgBytes);return concatBytes(numToBytesBE(magic,2),numToBytesBE(version,1),numToBytesBE(nonce,2),numToBytesBE(len,2),numToBytesBE(crc,4));}
function parseHeader(h,expectedMagic=MAGIC){if(h.length<11)return null;const magic=(h[0]<<8)|h[1];if(magic!==(expectedMagic&0xFFFF))return null;const version=h[2];if(version!==VERSION&&version!==PASSPHRASE_VERSION&&version!==PASSPHRASE_BOUND_VERSION)return null;const nonce=(h[3]<<8)|h[4],len=(h[5]<<8)|h[6],crc=(h[7]*2**24)|(h[8]<<16)|(h[9]<<8)|h[10];return{version,nonce,len,crc,magic};}
function interleavePayload(visible,payload){if(!visible)return payload;const chars=Array.from(visible),pchars=Array.from(payload),n=chars.length;if(!pchars.length)return visible;const perSlot=Math.ceil(pchars.length/Math.max(1,n));let idx=0,out='';for(let i=0;i<n;i++){out+=chars[i];for(let k=0;k<perSlot&&idx<pchars.length;k++,idx++)out+=pchars[idx];}while(idx<pchars.length)out+=pchars[idx++];return out;}
function xorWithKey(bytes,key){if(!key)return bytes;const kBytes=te.encode(key);const out=new Uint8Array(bytes.length);for(let i=0;i<bytes.length;i++)out[i]=bytes[i]^kBytes[i%kBytes.length];return out;}
function decodeUtf8Payload(bytes){try{const msg=new TextDecoder('utf-8',{fatal:true}).decode(bytes);return Array.from(msg).length?msg:null;}catch{return null;}}
function wrapPassphrasePayload(bytes){return concatBytes(PASSPHRASE_MARKER,numToBytesBE(crc32(bytes),4),bytes);}
function unwrapPassphrasePayload(bytes){if(bytes.length<8)return null;for(let i=0;i<PASSPHRASE_MARKER.length;i++)if(bytes[i]!==PASSPHRASE_MARKER[i])return null;const expected=(bytes[4]*2**24)|(bytes[5]<<16)|(bytes[6]<<8)|bytes[7];const payload=bytes.slice(8);return crc32(payload)===(expected>>>0)?payload:null;}
function wrapBoundPassphrasePayload(bytes,passphrase){return concatBytes(PASSPHRASE_BOUND_MARKER,numToBytesBE(crc32(te.encode(passphrase)),4),numToBytesBE(crc32(bytes),4),bytes);}
function unwrapBoundPassphrasePayload(bytes,passphrase){if(bytes.length<12)return null;for(let i=0;i<PASSPHRASE_BOUND_MARKER.length;i++)if(bytes[i]!==PASSPHRASE_BOUND_MARKER[i])return null;const expectedPassphrase=(bytes[4]*2**24)|(bytes[5]<<16)|(bytes[6]<<8)|bytes[7];if(crc32(te.encode(passphrase))!==(expectedPassphrase>>>0))return null;const expectedPayload=(bytes[8]*2**24)|(bytes[9]<<16)|(bytes[10]<<8)|bytes[11];const payload=bytes.slice(12);return crc32(payload)===(expectedPayload>>>0)?payload:null;}
function assertCarrierFree(text,alphabet,label){const carrierSet=new Set(alphabet);for(const ch of Array.from(text)){if(!carrierSet.has(ch))continue;const codePoint='U+'+ch.codePointAt(0).toString(16).toUpperCase().padStart(4,'0');throw new Error(`${label} already contains StegZero carrier character ${codePoint}. Inspect or remove it before encoding so the new message can be decoded reliably.`);}}

function assertOutputSize(visible, payloadBytes, bitsPerCarrier) {
  let remaining = MAX_ENCODED_CODE_POINTS - Math.ceil((11 + payloadBytes) * 8 / bitsPerCarrier);
  for (const ch of visible) {
    if (--remaining < 0) break;
  }
  if (remaining < 0) throw new RangeError('The encoded result would exceed 500,000 Unicode code points. Shorten the cover text or hidden message, or use Standard mode.');
}

function encodeMsg(visible,hidden,passphrase){assertCarrierFree(visible,ZW_ALPHABET,'The cover text');let msgBytes=te.encode(hidden),version=VERSION;if(passphrase){version=PASSPHRASE_BOUND_VERSION;msgBytes=xorWithKey(wrapBoundPassphrasePayload(msgBytes,passphrase),passphrase);}const nonce=Math.floor(Math.random()*0x10000)&0xFFFF;const header=buildHeader(nonce,msgBytes,version);assertOutputSize(visible,msgBytes.length,3);const headerBits=bytesToBits(header);const msgBits=bytesToBits(msgBytes);const seed=((nonce<<16)|MAGIC)>>>0;const obfBits=obfuscateBits(msgBits,seed);const payload=bitsToAlphabet(headerBits+obfBits);return interleavePayload(visible,payload);}

function getV2Header(text){const alphaSet=new Set(ZW_ALPHABET);let extracted='';for(const ch of Array.from(text))if(alphaSet.has(ch))extracted+=ch;if(!extracted.length)return null;const bits=alphabetToBits(extracted);return bits.length>=88?parseHeader(bitsToBytes(bits.slice(0,88))):null;}
function tryDecodeV2(text,passphrase){const alphaSet=new Set(ZW_ALPHABET);let extracted='';for(const ch of Array.from(text))if(alphaSet.has(ch))extracted+=ch;if(!extracted.length)return null;const bits=alphabetToBits(extracted);if(bits.length<88)return null;const headerBytes=bitsToBytes(bits.slice(0,88));const hdr=parseHeader(headerBytes);if(!hdr)return null;const needBits=hdr.len*8;const payloadBits=bits.slice(88,88+needBits);if(payloadBits.length<needBits)return null;const seed=((hdr.nonce<<16)|MAGIC)>>>0;const msgBits=obfuscateBits(payloadBits,seed);let msgBytes=bitsToBytes(msgBits);if(msgBytes.length!==hdr.len)return null;if(crc32(msgBytes)!==(hdr.crc>>>0))return null;if(hdr.version===PASSPHRASE_BOUND_VERSION){if(!passphrase)return null;msgBytes=unwrapBoundPassphrasePayload(xorWithKey(msgBytes,passphrase),passphrase);if(!msgBytes)return null;}else if(hdr.version===PASSPHRASE_VERSION){if(!passphrase)return null;msgBytes=unwrapPassphrasePayload(xorWithKey(msgBytes,passphrase));if(!msgBytes)return null;}else if(passphrase)msgBytes=xorWithKey(msgBytes,passphrase);return decodeUtf8Payload(msgBytes);}

function tryDecodeLegacy(text){const bits=Array.from(text).filter(c=>c===LEGACY_0||c===LEGACY_1).map(c=>c===LEGACY_0?'0':'1').join('');if(bits.length<8||bits.length%8!==0)return null;try{const msg=new TextDecoder('utf-8',{fatal:true}).decode(bitsToBytes(bits)).replace(/\x00+$/g,'');const chars=Array.from(msg);if(!chars.length)return null;const printable=chars.filter(c=>/[\p{Letter}\p{Mark}\p{Number}\p{Punctuation}\p{Symbol}\p{Separator}\p{Format}\t\r\n]/u.test(c)).length/chars.length;if(printable<0.85)return null;return msg;}catch{return null;}}

// ════════════════════════════════════════
// BINARY STEGANOGRAPHY ENGINE
// Uses only ZWSP (U+200B = 0) and ZWNJ (U+200C = 1)
// Same header structure as V2 but bits encoded 1-per-char
// Magic marker for binary: 0xB100 to distinguish from V2
// ════════════════════════════════════════
const BIN_0 = '\u200B'; // bit 0 = ZWSP
const BIN_1 = '\u200C'; // bit 1 = ZWNJ
const BIN_SET = new Set([BIN_0, BIN_1]);
const BINARY_MAGIC = 0xB100; // distinct from V2 MAGIC (0xA55A)

function bitsToBinary(bits) {
  let out = '';
  for (let i = 0; i < bits.length; i++) out += bits[i] === '1' ? BIN_1 : BIN_0;
  return out;
}

function binaryToBits(str) {
  let bits = '';
  for (const ch of Array.from(str)) {
    if (ch === BIN_0) bits += '0';
    else if (ch === BIN_1) bits += '1';
  }
  return bits;
}

function encodeMsgBinary(visible, hidden, passphrase) {
  assertCarrierFree(visible, [BIN_0, BIN_1], 'The cover text');
  let msgBytes = te.encode(hidden);
  let version = VERSION;
  if (passphrase) { version = PASSPHRASE_BOUND_VERSION; msgBytes = xorWithKey(wrapBoundPassphrasePayload(msgBytes, passphrase), passphrase); }
  const nonce = Math.floor(Math.random() * 0x10000) & 0xFFFF;
  // Build header with BINARY_MAGIC
  const header = buildHeader(nonce, msgBytes, version, BINARY_MAGIC);
  assertOutputSize(visible, msgBytes.length, 1);
  const headerBits = bytesToBits(header);
  const msgBits = bytesToBits(msgBytes);
  const seed = ((nonce << 16) | BINARY_MAGIC) >>> 0;
  const obfBits = obfuscateBits(msgBits, seed);
  const payload = bitsToBinary(headerBits + obfBits);
  return interleavePayload(visible, payload);
}

function tryDecodeBinary(text, passphrase) {
  // Extract only BIN_0 / BIN_1 chars
  let extracted = '';
  for (const ch of Array.from(text)) {
    if (ch === BIN_0 || ch === BIN_1) extracted += ch;
  }
  if (!extracted.length) return null;
  const bits = binaryToBits(extracted);
  if (bits.length < 88) return null;
  const headerBytes = bitsToBytes(bits.slice(0, 88));
  const hdr = parseHeader(headerBytes, BINARY_MAGIC);
  if (!hdr) return null;
  const { version, nonce, len, crc } = hdr;
  const needBits = len * 8;
  const payloadBits = bits.slice(88, 88 + needBits);
  if (payloadBits.length < needBits) return null;
  const seed = ((nonce << 16) | BINARY_MAGIC) >>> 0;
  const msgBits = obfuscateBits(payloadBits, seed);
  let msgBytes = bitsToBytes(msgBits);
  if (msgBytes.length !== len) return null;
  if (crc32(msgBytes) !== (crc >>> 0)) return null;
  if (version === PASSPHRASE_BOUND_VERSION) {
    if (!passphrase) return null;
    msgBytes = unwrapBoundPassphrasePayload(xorWithKey(msgBytes, passphrase), passphrase);
    if (!msgBytes) return null;
  } else if (version === PASSPHRASE_VERSION) {
    if (!passphrase) return null;
    msgBytes = unwrapPassphrasePayload(xorWithKey(msgBytes, passphrase));
    if (!msgBytes) return null;
  } else if (passphrase) msgBytes = xorWithKey(msgBytes, passphrase);
  return decodeUtf8Payload(msgBytes);
}

function getBinaryHeader(text) {
  let extracted = '';
  for (const ch of Array.from(text)) if (ch === BIN_0 || ch === BIN_1) extracted += ch;
  const bits = binaryToBits(extracted);
  return bits.length >= 88 ? parseHeader(bitsToBytes(bits.slice(0, 88)), BINARY_MAGIC) : null;
}

// Detect if text has a binary-mode payload (BINARY_MAGIC in header)
function hasBinarySignature(text) {
  let extracted = '';
  for (const ch of Array.from(text)) {
    if (ch === BIN_0 || ch === BIN_1) extracted += ch;
  }
  if (extracted.length < 88) return false;
  return getBinaryHeader(text) !== null;
}

function getFileType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  if (['json'].includes(ext)) return 'json';
  if (['csv'].includes(ext)) return 'csv';
  if (ext === 'xml') return 'xml';
  if (['html','htm'].includes(ext)) return 'html';
  return 'text';
}

// CSV carriers belong inside field content, never between a closing quote and a delimiter.
function csvWatermarkPosition(content) {
  let i = 0, first = null, preferred = null;
  while (i < content.length) {
    let value = '', position;
    if (content[i] === '"') {
      i++;
      let closed = false;
      while (i < content.length) {
        if (content[i] !== '"') { value += content[i++]; continue; }
        if (content[i + 1] === '"') { value += '"'; i += 2; continue; }
        position = i++;
        closed = true;
        break;
      }
      if (!closed || (i < content.length && ![',', '\r', '\n'].includes(content[i]))) {
        throw new Error('The CSV contains an invalid quoted field. Fix it before watermarking.');
      }
    } else {
      while (i < content.length && ![',', '\r', '\n'].includes(content[i])) {
        if (content[i] === '"') throw new Error('The CSV contains an unescaped quote. Fix it before watermarking.');
        value += content[i++];
      }
      position = i;
    }
    if (first === null) first = position;
    if (preferred === null && value.trim() && !Number.isFinite(Number(value))) preferred = position;
    if (content[i] === '\r' && content[i + 1] === '\n') i += 2;
    else if (i < content.length) i++;
  }
  return preferred ?? first ?? 0;
}

function wmEncode(content, wmId, fileType) {
  assertCarrierFree(content, ZW_ALPHABET, 'The source file');
  if (fileType === 'json') {
    // JSON permits only ordinary spaces, tabs, CR and LF outside values.
    // A framed whitespace trailer preserves every parsed key and value.
    try { JSON.parse(content); }
    catch (_) { throw new Error('The source file is not valid JSON. Fix it before watermarking.'); }
    if (wmDecode(content)) throw new Error('The source file already contains a StegZero watermark.');
    const payload = encodeMsg('', wmId, null);
    return content + '\n' + alphabetToBits(payload).replace(/0/g, ' ').replace(/1/g, '\t') + '\n';
  }
  const payload = encodeMsg('', wmId, null);
  if (fileType === 'html' || fileType === 'xml') {
    // Comments may precede a doctype or root, but must follow an XML declaration.
    const declaration = content.match(/^<\?xml\s[\s\S]*?\?>/);
    const position = declaration ? declaration[0].length : 0;
    return content.slice(0, position) + '<!--' + payload + '-->' + content.slice(position);
  }
  if (fileType === 'csv') {
    const position = csvWatermarkPosition(content);
    return content.slice(0, position) + payload + content.slice(position);
  }
  const chars = Array.from(content), payloadChars = Array.from(payload);
  const safePositions = [];
  for (let i = 0; i < chars.length; i++) if (/\S/.test(chars[i])) safePositions.push(i + 1);
  if (!safePositions.length) return content + payload;
  const step = Math.max(1, Math.floor(safePositions.length / payloadChars.length));
  const insertAt = new Map();
  for (let i = 0; i < payloadChars.length; i++) {
    const position = safePositions[Math.min(i * step, safePositions.length - 1)];
    insertAt.set(position, (insertAt.get(position) || '') + payloadChars[i]);
  }
  return chars.map((ch, i) => ch + (insertAt.get(i + 1) || '')).join('');
}

function wmDecode(content) {
  const legacy = tryDecodeV2(content, null);
  if (legacy !== null) return legacy;
  // A new JSON watermark is a final line of spaces/tabs carrying the Standard frame.
  const trailer = content.match(/\n([ \t]{90,524370})\n?$/);
  if (!trailer) return null;
  const bits = trailer[1].replace(/ /g, '0').replace(/\t/g, '1');
  return tryDecodeV2(bitsToAlphabet(bits), null);
}

// Counts the carrier bits available in framed text so callers can distinguish a
// damaged frame from a passphrase-protected one without reimplementing detection.
function countCarrierBits(text, mode) {
  if (mode === 'compatibility') {
    let count = 0;
    for (const ch of Array.from(text)) if (ch === BIN_0 || ch === BIN_1) count++;
    return count;
  }
  return alphabetToBits(text).length;
}

// Node/CommonJS adapter for the CLI. When loaded as a classic browser script,
// `module` is undefined, so the existing globals and wire formats are untouched.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    VERSION, PASSPHRASE_VERSION, PASSPHRASE_BOUND_VERSION,
    encodeMsg, tryDecodeV2, getV2Header,
    encodeMsgBinary, tryDecodeBinary, getBinaryHeader,
    tryDecodeLegacy, getFileType, wmEncode, wmDecode, countCarrierBits
  };
}
