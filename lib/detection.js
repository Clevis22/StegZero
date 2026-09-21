'use strict';

// Side-effect-free payload detection shared by `reveal` and `inspect`.
// Detection order matches the website: Standard, then Compatibility, then Legacy.

function frameFailure(format, header, hasPassphrase, availableBits, protocol) {
  const requiredBits = 88 + header.len * 8;
  if (availableBits < requiredBits) {
    return {
      format, status: 'damaged', verified: false, message: null, header,
      code: 'DAMAGED_PAYLOAD'
    };
  }
  if (header.version === protocol.PASSPHRASE_VERSION || header.version === protocol.PASSPHRASE_BOUND_VERSION) {
    return hasPassphrase
      ? { format, status: 'passphrase-mismatch', verified: false, message: null, header, code: 'PASSPHRASE_MISMATCH' }
      : { format, status: 'passphrase-required', verified: false, message: null, header, code: 'PASSPHRASE_REQUIRED' };
  }
  // Version 1 obfuscation cannot verify a passphrase, so a failed decode is
  // reported as an unverified possibility rather than a hard mismatch.
  return { format, status: 'possible', verified: false, message: null, header, code: 'UNVERIFIED_PAYLOAD' };
}

function detectPayload(text, passphrase, engines) {
  const { protocol } = engines;
  const pass = passphrase || null;

  const v2Header = protocol.getV2Header(text);
  const binaryHeader = protocol.getBinaryHeader(text);

  const standard = protocol.tryDecodeV2(text, pass);
  if (standard !== null) {
    const unverifiedV1 = !!pass && !!v2Header && v2Header.version === protocol.VERSION;
    return {
      format: 'standard', status: 'decoded', verified: !unverifiedV1,
      message: standard, header: v2Header, code: unverifiedV1 ? 'UNVERIFIED_PAYLOAD' : null
    };
  }

  const compatibility = protocol.tryDecodeBinary(text, pass);
  if (compatibility !== null) {
    const unverifiedV1 = !!pass && !!binaryHeader && binaryHeader.version === protocol.VERSION;
    return {
      format: 'compatibility', status: 'decoded', verified: !unverifiedV1,
      message: compatibility, header: binaryHeader, code: unverifiedV1 ? 'UNVERIFIED_PAYLOAD' : null
    };
  }

  const legacy = protocol.tryDecodeLegacy(text);
  if (legacy !== null) {
    return {
      format: 'legacy', status: 'decoded', verified: false,
      message: legacy, header: null, code: 'UNVERIFIED_PAYLOAD'
    };
  }

  if (v2Header) {
    return frameFailure('standard', v2Header, !!pass, protocol.countCarrierBits(text, 'standard'), protocol);
  }
  if (binaryHeader) {
    return frameFailure('compatibility', binaryHeader, !!pass, protocol.countCarrierBits(text, 'compatibility'), protocol);
  }

  const legacyBits = protocol.countCarrierBits(text, 'compatibility');
  if (legacyBits >= 8 && legacyBits % 8 === 0) {
    return {
      format: 'legacy', status: 'possible', verified: false,
      message: null, header: null, code: 'UNVERIFIED_PAYLOAD'
    };
  }

  return { format: null, status: 'none', verified: false, message: null, header: null, code: 'NO_PAYLOAD' };
}

module.exports = { detectPayload };
