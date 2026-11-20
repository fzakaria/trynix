# `nix build .#site` — the whole deployable tree, so the pages workflow
# only has to upload what nix built:
#
#   index.html, style.css, js.<hash>/   the site itself
#   vendor/                             pinned browser dependencies,
#                                       the unkernel engine among them
#   qemu/                               the qemu engine and the snapshot
#   guest/                              kernel, initramfs, BIOS blobs
#   assets.json                         content hashes for the above
#
# The engine and snapshot are fetches rather than builds (nix/engine.nix
# explains why), but they are pinned by hash, so this derivation is
# still a complete and reproducible description of what gets served.
{ pkgs }:
let
  vendor = import ./vendor.nix { inherit pkgs; };
  engine = import ./engine.nix { inherit pkgs; };
  guest = (import ./guest.nix { inherit pkgs; }).guest;
in
pkgs.runCommand "trynix-site" { nativeBuildInputs = [ pkgs.python3 ]; } ''
  mkdir -p $out
  # The site directory alone, rather than a subpath of the whole flake
  # source: reaching through `self` would make every file in the tree an
  # input, so a change to a patch, a tool or a doc rebuilt the site and
  # invalidated its cached copy for no reason.
  cp -r ${../site}/. $out/
  chmod -R u+w $out
  cp -r ${vendor} $out/vendor
  chmod -R u+w $out/vendor

  # The COOP/COEP service worker must sit at the site root: a worker's
  # scope is its directory, and a worker under vendor/ can never control
  # index.html — it would reload the page forever trying.
  mv $out/vendor/coi-serviceworker.js $out/coi-serviceworker.js

  mkdir -p $out/qemu $out/guest
  cp ${engine}/* $out/qemu/
  cp ${guest}/* $out/guest/
  chmod -R u+w $out/qemu $out/guest

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

  # The unkernel entry is fetched by a versioned URL (assets.json,
  # below), but the entry imports its one chunk by a bare relative
  # path, which no version reaches. The chunk's hash goes into that
  # import, so a new unkernel release can never pair a fresh entry with
  # a browser's cached copy of the old chunk. Done before the versions
  # are taken, so the entry's own version covers the import it carries.
  chunk=$(sha256sum $out/vendor/unkernel/_chunks/core.mjs | cut -c1-12)
  substituteInPlace $out/vendor/unkernel/web.mjs \
    --replace-fail '"./_chunks/core.mjs"' "\"./_chunks/core.mjs?v=$chunk\""

  # The same trick for the files the page fetches by a fixed name and
  # keeps in the browser's Cache API, which keys on the URL: their
  # content hashes ride as a query string instead.
  python3 ${../tools/asset-versions.py} $out qemu guest vendor/unkernel

  # And for the benchmark page's script and stylesheet, which live beside
  # it rather than under js/: a query string per content hash, so a
  # deploy never pairs the page with a browser's cached copy of the old
  # script. Its data file is fetched with no-store and needs nothing.
  for name in bench.js bench.css; do
    hash=$(sha256sum "$out/bench/$name" | cut -c1-12)
    substituteInPlace $out/bench/index.html --replace-fail "\"$name\"" "\"$name?v=$hash\""
  done
''
