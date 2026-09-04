# `nix build .#site` — the exact tree the pages workflow deploys and
# `nix run .#serve` tests locally. Today the tree is site/ verbatim; the
# qemu-wasm artifacts, guest kernel and multiverse data shards will join
# it as the runtime lands (docs/design.md holds the plan).
{
  pkgs,
  self,
}:
pkgs.runCommand "trynix-site" { } ''
  mkdir -p $out
  cp -r ${self}/site/. $out/
  chmod -R u+w $out

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
