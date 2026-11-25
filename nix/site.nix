# `nix build .#site` — the whole deployable tree, so the pages workflow
# only has to upload what nix built:
#
#   index.html, style.<hash>.css,       the site itself
#   js.<hash>/
#   vendor/                             pinned browser dependencies,
#                                       the unkernel engine among them
#   qemu/                               the qemu engine and the snapshot
#   guest/                              kernel, initramfs, BIOS blobs
#   gui.<hash>/                         the GUI compositor, its relay
#                                       and the guest's fonts
#   gl/                                 the guest's GL driver, committed,
#                                       and its Vulkan driver, built
#   assets.json                         content hashes for the above
#
# The engine and snapshot are fetches rather than builds (nix/engine.nix
# explains why), but they are pinned by hash, so this derivation is
# still a complete and reproducible description of what gets served.
{ pkgs }:
let
  vendor = import ./vendor.nix { inherit pkgs; };
  unzstd = import ./unzstd-wasm.nix { inherit pkgs; };
  engine = import ./engine.nix { inherit pkgs; };
  guest = (import ./guest.nix { inherit pkgs; }).guest;
  wlandr = import ./wlandr.nix { inherit pkgs; };
  kwvk = import ./kwvk.nix { inherit pkgs; };

  # The guest's fonts: one monospace for terminals and one proportional
  # for everything else. The names are the ones nixpkgs' dejavu_fonts
  # installs; DejaVuSans.ttf is a link there, which cp follows.
  fonts = [
    "DejaVuSansMono.ttf"
    "DejaVuSans.ttf"
  ];

  # The fonts' license, which asks to travel with them; nixpkgs'
  # dejavu_fonts installs the fonts alone. The tag is the release
  # nixpkgs builds.
  fontsLicense = pkgs.fetchurl {
    url = "https://raw.githubusercontent.com/dejavu-fonts/dejavu-fonts/version_2_37/LICENSE";
    sha256 = "14wajpjybsk1l5dzw261chphvlbxbhg7a69l9iwn9l34dq9kn23s";
  };

  # What the build runs: python3 for the tools, and nix and kwvk's
  # references for kwvk's narinfo (tools/site-cache.py).
  inputs = {
    nativeBuildInputs = [
      pkgs.nix
      pkgs.python3
    ];
    exportReferencesGraph = [
      "kwvk-graph"
      kwvk
    ];
  };
in
pkgs.runCommand "trynix-site" inputs ''
  mkdir -p $out
  # The site directory alone, rather than a subpath of the whole flake
  # source: reaching through `self` would make every file in the tree an
  # input, so a change to a patch, a tool or a doc rebuilt the site and
  # invalidated its cached copy for no reason.
  cp -r ${../site}/. $out/
  chmod -R u+w $out
  cp -r ${vendor} $out/vendor
  chmod -R u+w $out/vendor

  # The zstd decoder's wasm, as the script unzstd.js reads it from
  # (nix/unzstd-wasm.nix). Under js/, before js/ is hashed below, so
  # the hash covers it and a deploy with a new decoder is a new js.<hash>.
  cp ${unzstd}/unzstd-wasm.js $out/js/unzstd-wasm.js

  # The COOP/COEP service worker must sit at the site root: a worker's
  # scope is its directory, and a worker under vendor/ can never control
  # index.html — it would reload the page forever trying.
  mv $out/vendor/coi-serviceworker.js $out/coi-serviceworker.js

  mkdir -p $out/qemu $out/guest
  cp ${engine}/* $out/qemu/
  cp ${guest}/* $out/guest/
  chmod -R u+w $out/qemu $out/guest

  # What a GUI program in the unkernel guest needs from the site
  # (docs/gui.md), in one directory: wland's compositor (modules and
  # wasm, from vendor.nix), its relay, which the page writes into the
  # guest, and two fonts, because a nixpkgs GUI program's closure
  # carries fontconfig but no font, and foot will not start without one.
  # The modules import each other by relative path, so the directory is
  # renamed after a hash of its contents, as js/ is below, and the one
  # module that names it is rewritten to match. That happens before
  # js/ is hashed, so the new name is part of js/'s hash.
  mv $out/vendor/wland $out/gui
  mv $out/gui/LICENSE $out/gui/LICENSE-wland
  cp ${wlandr}/bin/wlandr $out/gui/wlandr
  for font in ${pkgs.lib.concatStringsSep " " fonts}; do
    cp ${pkgs.dejavu_fonts}/share/fonts/truetype/$font $out/gui/
  done
  cp ${fontsLicense} $out/gui/LICENSE-dejavu
  hash=$(find $out/gui -type f | LC_ALL=C sort |
    xargs sha256sum | sha256sum | cut -c1-12)
  mv $out/gui "$out/gui.$hash"
  substituteInPlace $out/js/config.js \
    --replace-fail '"gui"' "\"gui.$hash\""

  # The guest's Vulkan driver, kwvk with trynix's patches
  # (nix/kwvk.nix), as a store path in the site's cache beside the GL
  # driver, and named in the manifest the page reads (drivers.json).
  # The guest fetches it the first time a program loads Vulkan. Unlike
  # the GL driver's, these files are written here from the build rather
  # than committed: zig builds the driver from any system.
  HOME=$TMPDIR python3 ${../tools/site-cache.py} $out/gl/cache $out/gl/drivers.json \
    kwvk-graph ${kwvk}

  # The CA certificates the unkernel guest checks HTTPS servers against
  # when its network is on (site/js/network.js): nixpkgs' cacert, which
  # moves with this flake's nixpkgs. Renamed after a hash of its
  # contents, as gui/ is above, so a deploy with new certificates is
  # fetched fresh.
  mkdir -p $out/certs
  cp ${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt $out/certs/ca-bundle.crt
  hash=$(sha256sum $out/certs/ca-bundle.crt | cut -c1-12)
  mv $out/certs "$out/certs.$hash"
  substituteInPlace $out/js/config.js \
    --replace-fail '"certs"' "\"certs.$hash\""

  # The stylesheet, renamed after a hash of its contents as js/ is
  # below. Under one fixed name a browser could keep an earlier deploy's
  # stylesheet and pair it with the new modules: GitHub Pages lets it
  # keep files for ten minutes, and `nix run .#serve` serves the store's
  # 1970 mtimes, which let it keep them for years.
  hash=$(sha256sum $out/style.css | cut -c1-12)
  mv $out/style.css "$out/style.$hash.css"
  substituteInPlace $out/index.html \
    --replace-fail 'href="style.css"' "href=\"style.$hash.css\""
  substituteInPlace $out/bench/index.html \
    --replace-fail 'href="../style.css"' "href=\"../style.$hash.css\""

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
  # below), but the entry imports its main chunk by a bare relative
  # path, which no version reaches. The chunk's hash goes into that
  # import, so a new unkernel release can never pair a fresh entry with
  # a browser's cached copy of the old chunk. Done before the versions
  # are taken, so the entry's own version covers the import it carries.
  chunk=$(sha256sum $out/vendor/unkernel/_chunks/core.mjs | cut -c1-12)
  substituteInPlace $out/vendor/unkernel/web.mjs \
    --replace-fail '"./_chunks/core.mjs"' "\"./_chunks/core.mjs?v=$chunk\""

  # The same for guest Vulkan's two chunks, which the entry imports on
  # the guest's first VkInstance. Each chunk imports core.mjs by a bare
  # name as well, and must name the URL the entry imports it by: the
  # browser keys modules on the URL, and under any other it would fetch
  # and run a second copy of core.mjs. The translator's wasm needs no
  # rewrite: the page passes the SDK its versioned URL from assets.json.
  for name in vk-host vk-shader; do
    substituteInPlace $out/vendor/unkernel/_chunks/$name.mjs \
      --replace-fail '"./core.mjs"' "\"./core.mjs?v=$chunk\""
    hash=$(sha256sum $out/vendor/unkernel/_chunks/$name.mjs | cut -c1-12)
    substituteInPlace $out/vendor/unkernel/web.mjs \
      --replace-fail "\"./_chunks/$name.mjs\"" "\"./_chunks/$name.mjs?v=$hash\""
  done

  # The same for the GL renderer: the page fetches virgl.mjs by its
  # versioned URL, and the module asks for virgl.wasm by a bare name
  # beside it, which no version reaches either.
  wasm=$(sha256sum $out/vendor/unkernel/virgl.wasm | cut -c1-12)
  substituteInPlace $out/vendor/unkernel/virgl.mjs \
    --replace-fail '"virgl.wasm"' "\"virgl.wasm?v=$wasm\""

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
