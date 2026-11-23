// The URL is the boot's state. Everything selected lives in the query
// string, so any environment is a link someone can send:
//
//   ?pkg=jujutsu@0.43.0&pkg=hello@2.12.3   attribute at a version
//   ?pkg=ripgrep                           newest version in the index
//   ?path=/nix/store/<digest>-name         a store path, verbatim
//   &cache=https://x.cachix.org x-1:key=   an extra binary cache
//   &engine=qemu                           the engine, when not the default
//   &mem=2048                              the unkernel guest's memory, MiB
//   &boot=1                                start without a click
//
// Everything is written back with replaceState as it changes, so the
// address bar is always the link for what is on screen — a store path
// from someone's cachix and the key that vouches for it travel in the
// same link as the selection.

const PARAM_PKG = "pkg";
const PARAM_PATH = "path";
const PARAM_CACHE = "cache";
const PARAM_ENGINE = "engine";
const PARAM_MEMORY = "mem";
const PARAM_BOOT = "boot";
const VERSION_SEPARATOR = "@";

// { pkgs: [{attr, version|null}], paths: [string],
//   caches: [{url, key}], engine: string|null, memory: number|null,
//   boot: boolean }
//
// The engine is handed back as written, or null when the link names
// none: engine.js decides what a missing or unknown name means.
export function readUrl() {
  const params = new URLSearchParams(location.search);

  const pkgs = params.getAll(PARAM_PKG).flatMap((spec) =>
    spec
      .split(",")
      .filter(Boolean)
      .map((one) => {
        const at = one.lastIndexOf(VERSION_SEPARATOR);
        if (at === -1) {
          return { attr: one, version: null };
        }
        return { attr: one.slice(0, at), version: one.slice(at + 1) };
      }),
  );

  const paths = params
    .getAll(PARAM_PATH)
    .flatMap((p) => p.split(",").filter(Boolean));

  // "url key", whitespace between; a value without a key is dropped
  // rather than trusted.
  const caches = params
    .getAll(PARAM_CACHE)
    .map((value) => value.trim().split(/\s+/))
    .filter((parts) => parts.length === 2)
    .map(([url, key]) => ({ url: url.replace(/\/$/, ""), key }));

  return {
    pkgs,
    paths,
    caches,
    engine: params.get(PARAM_ENGINE),
    memory: memoryOf(params.get(PARAM_MEMORY)),
    boot: params.get(PARAM_BOOT) === "1",
  };
}

// A memory size as a link writes it, in MiB, or null when the link
// names none or names something that is not a whole number. Whether the
// page offers that size is memory.js's question.
function memoryOf(value) {
  if (value === null || !/^\d+$/.test(value)) {
    return null;
  }
  return Number(value);
}

// Rewrite the address bar to describe the current selection. `boot`
// stays out unless asked for: a shared link should offer the boot, and
// only the reload path wants it automatic. `engine` stays out unless
// the caller names one, which keeps a link for the default engine as
// short as a link was before there were two; `memory` likewise.
export function writeUrl(
  { pkgs, paths, caches = [] },
  { boot = false, engine = null, memory = null } = {},
) {
  const params = new URLSearchParams();
  for (const { attr, version } of pkgs) {
    params.append(
      PARAM_PKG,
      version === null ? attr : `${attr}${VERSION_SEPARATOR}${version}`,
    );
  }
  for (const path of paths) {
    params.append(PARAM_PATH, path);
  }
  for (const { url, key } of caches) {
    params.append(PARAM_CACHE, `${url} ${key}`);
  }
  if (engine !== null) {
    params.set(PARAM_ENGINE, engine);
  }
  if (memory !== null) {
    params.set(PARAM_MEMORY, String(memory));
  }
  if (boot) {
    params.set(PARAM_BOOT, "1");
  }

  const query = params.toString();
  return `${location.pathname}${query === "" ? "" : `?${query}`}`;
}
