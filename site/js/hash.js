// The hashes a narinfo carries, and checking bytes against them.
//
// A narinfo names the sha256 of the compressed file (FileHash) and of
// the unpacked archive (NarHash). Checking the file hash is what tells
// a download that ended short, or a cached copy that went bad, from
// the real thing — the page once decoded a truncated NAR as far as it
// went, kept the truncated bytes in the cache, and failed the same
// package on every later visit.
//
// Which encoding those hashes are written in is up to the cache.
// cache.nixos.org writes nix's own base32; cachix writes FileHash in
// hex; nix will also print base64. Nix tells them apart by length and
// so does this, because a page that only reads base32 cannot check a
// cachix NAR at all.

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

const HEX_DIGITS_PER_BYTE = 2;

function decodeHex(text, size) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) {
    const digits = text.slice(
      i * HEX_DIGITS_PER_BYTE,
      (i + 1) * HEX_DIGITS_PER_BYTE,
    );
    const byte = Number.parseInt(digits, 16);
    if (Number.isNaN(byte)) {
      throw new Error(`not a hex hash: ${text}`);
    }
    bytes[i] = byte;
  }
  return bytes;
}

function decodeBase64(text, size) {
  const binary = atob(text);
  if (binary.length !== size) {
    throw new Error(
      `base64 hash is ${binary.length} bytes, not ${size}: ${text}`,
    );
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

// How long a digest of `size` bytes is in each encoding a cache may
// have written it in. Lengths do not collide for sha256 — 64, 52 and
// 44 — so the length names the encoding, which is how nix reads them.
function decodersFor(size) {
  return [
    [size * HEX_DIGITS_PER_BYTE, decodeHex],
    [Math.ceil((size * BITS_PER_BYTE) / BITS_PER_DIGIT), decodeNixBase32],
    [Math.ceil(size / 3) * 4, decodeBase64],
  ];
}

// "sha256:<hex | nix base32 | base64>" -> { algorithm, bytes }.
export function parseHash(field) {
  const [algorithm, text] = field.split(":");
  const size = DIGEST_SIZES[algorithm];
  if (size === undefined || text === undefined) {
    throw new Error(`unsupported hash: ${field}`);
  }

  const match = decodersFor(size).find(([length]) => length === text.length);
  if (match === undefined) {
    throw new Error(`hash is not a sha256 in any known encoding: ${field}`);
  }
  const [, decode] = match;
  return { algorithm, bytes: decode(text, size) };
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
