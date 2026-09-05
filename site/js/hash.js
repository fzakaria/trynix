// The hashes a narinfo carries, and checking bytes against them.
//
// A narinfo names the sha256 of the compressed file (FileHash) and of
// the unpacked archive (NarHash), in nix's own base32. Checking the
// file hash is what tells a download that ended short, or a cached
// copy that went bad, from the real thing — the page once decoded a
// truncated NAR as far as it went, kept the truncated bytes in the
// cache, and failed the same package on every later visit.

// Nix's alphabet: base32 without e, o, t and u.
const ALPHABET = "0123456789abcdfghijklmnpqrsvwxyz";
const BITS_PER_DIGIT = 5;
const BITS_PER_BYTE = 8;

// nix's decoder, transliterated: digits are read from the end of the
// string, and each contributes five bits at an offset that grows by
// five, spilling into the next byte.
export function decodeNixBase32(text, size) {
  const bytes = new Uint8Array(size);
  for (let n = 0; n < text.length; n += 1) {
    const digit = ALPHABET.indexOf(text[text.length - 1 - n]);
    if (digit === -1) {
      throw new Error(`not a nix base32 hash: ${text}`);
    }
    const bit = n * BITS_PER_DIGIT;
    const i = Math.floor(bit / BITS_PER_BYTE);
    const j = bit % BITS_PER_BYTE;
    bytes[i] |= digit << j;
    const carry = digit >> (BITS_PER_BYTE - j);
    if (i < size - 1) {
      bytes[i + 1] |= carry;
    } else if (carry !== 0) {
      throw new Error(`nix base32 hash has stray bits: ${text}`);
    }
  }
  return bytes;
}

const DIGEST_SIZES = { sha256: 32 };

// "sha256:<base32>" -> { algorithm, bytes }.
export function parseHash(field) {
  const [algorithm, text] = field.split(":");
  const size = DIGEST_SIZES[algorithm];
  if (size === undefined || text === undefined) {
    throw new Error(`unsupported hash: ${field}`);
  }
  return { algorithm, bytes: decodeNixBase32(text, size) };
}

// Whether `bytes` hash to what the narinfo says. Null when this
// browser cannot hash (no SubtleCrypto outside a secure context), which
// is not the same claim as a mismatch.
export async function verifyHash(bytes, field) {
  if (globalThis.crypto?.subtle === undefined) {
    return null;
  }
  const expected = parseHash(field);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return (
    digest.length === expected.bytes.length &&
    digest.every((byte, i) => byte === expected.bytes[i])
  );
}
