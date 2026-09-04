// Site-wide constants.

// The binary cache the closure walk and NAR fetches read from. The cache
// answers browser fetches directly: it serves
// `access-control-allow-origin: *` (verified 2026-09-04 on nix-cache-info
// and narinfo responses alike), so no proxy or server sits anywhere in
// the pipeline.
export const CACHE_URL = "https://cache.nixos.org";

// A store basename is <digest>-<name>; the digest is 32 characters of
// nix base32, which draws from lowercase letters and digits.
export const DIGEST_LENGTH = 32;
export const DIGEST_PATTERN = /^[0-9a-z]{32}$/;

// How many narinfo fetches fly at once during a closure walk. The bound
// exists for the browser's connection queue, not for the cache.
export const FETCH_CONCURRENCY = 20;
