// The URL is the boot's state. Everything selected lives in the query
// string, so any environment is a link someone can send:
//
//   ?pkg=jujutsu@0.43.0&pkg=hello@2.12.3   attribute at a version
//   ?pkg=ripgrep                           newest version in the index
//   ?path=/nix/store/<digest>-name         a store path, verbatim
//   &boot=1                                start without a click
//
// Selections are written back with replaceState as they change, so the
// address bar is always the link for what is on screen.

const PARAM_PKG = "pkg";
const PARAM_PATH = "path";
const PARAM_BOOT = "boot";
const VERSION_SEPARATOR = "@";

// { pkgs: [{attr, version|null}], paths: [string], boot: boolean }
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

  return { pkgs, paths, boot: params.get(PARAM_BOOT) === "1" };
}

// Rewrite the address bar to describe the current selection. `boot`
// stays out unless asked for: a shared link should offer the boot, and
// only the reload path wants it automatic.
export function writeUrl({ pkgs, paths }, { boot = false } = {}) {
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
  if (boot) {
    params.set(PARAM_BOOT, "1");
  }

  const query = params.toString();
  return `${location.pathname}${query === "" ? "" : `?${query}`}`;
}
