# `nix build .#site` — the static site tree: site/ plus the vendored
# browser dependencies (nix/vendor.nix). The qemu engine artifacts and
# the guest image are overlaid at serve/deploy time — the engine because
# it is built out-of-band (docker + emscripten, see docs/design.md) and
# published as a release asset rather than committed, the guest so that
# a site iteration does not wait on a kernel build.
{
  pkgs,
  self,
}:
let
  vendor = import ./vendor.nix { inherit pkgs; };
in
pkgs.runCommand "trynix-site" { } ''
  mkdir -p $out
  cp -r ${self}/site/. $out/
  chmod -R u+w $out
  cp -r ${vendor} $out/vendor
  chmod -R u+w $out/vendor

  # The COOP/COEP service worker must sit at the site root: a worker's
  # scope is its directory, and a worker under vendor/ can never control
  # index.html — it would reload the page forever trying.
  mv $out/vendor/coi-serviceworker.js $out/coi-serviceworker.js

  # The footer names the store path serving the page (a benign
  # self-reference, same as the multiverse and grail sites).
  substituteInPlace $out/js/app.js --replace-fail "__STORE_PATH__" "$out"

  # The multiverse cache-busting trick, verbatim: hash the module tree and
  # rename it js.<hash>, so the served HTML and every module it pulls in
  # can never be a mismatched pair across deploys. Modules import each
  # other by relative path, so renaming the directory breaks nothing.
  hash=$(find $out/js -type f | LC_ALL=C sort |
    xargs sha256sum | sha256sum | cut -c1-12)
  mv $out/js "$out/js.$hash"
  substituteInPlace $out/index.html --replace-fail "js/app.js" "js.$hash/app.js"
''
