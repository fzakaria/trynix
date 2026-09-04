# Vendored browser dependencies, pinned by hash and served same-origin.
# Same-origin is not just hygiene: the page is cross-origin isolated
# (COOP/COEP, for SharedArrayBuffer), and every cross-origin subresource
# would need CORP headers we do not control on a CDN.
#
# xterm and xterm-pty are UMD bundles exposing globals (Terminal,
# openpty); xterm-pty is pinned to the version whose emscripten-pty.js
# the qemu-wasm build linked against. xzwasm exposes the xzwasm global
# with XzReadableStream; fzstd exposes fzstd with decompress — the cache
# serves xz for older paths and zstd for newer ones. coi-serviceworker
# injects the COOP/COEP headers on hosts that cannot set them (GitHub
# Pages).
{ pkgs }:
let
  npm =
    name: version: sha256:
    pkgs.fetchurl {
      url = "https://registry.npmjs.org/${name}/-/${name}-${version}.tgz";
      inherit sha256;
    };

  xterm = npm "xterm" "5.3.0" "11db21afvny4m8ar40jpbc5wb5kgx4wqcbha0w2ixbr8p1l82lhz";
  xtermPty = npm "xterm-pty" "0.10.1" "0jj3m2lhnvxk65b0mwa5f1dpfq22ilsyw6b61rn51ccs9kyk276a";
  xzwasm = npm "xzwasm" "0.1.2" "18zc8z5hfy34cy3z7a5baz07hccl2y0y17y7qsxiy4wsw8v6ig7n";
  fzstd = npm "fzstd" "0.1.1" "1ia5gjcs9r9pfj4jqd3jac233a08qy9342fh27i7n1ir6hnyxljy";
  coi = npm "coi-serviceworker" "0.1.7" "05ln49m3gfi5x71azfbvmb0ww13ii2xmvkr3x46j45g2913nsm3a";
in
pkgs.runCommand "trynix-js-vendor" { } ''
  mkdir -p $out unpack
  tar -xzf ${xterm} -C unpack
  cp unpack/package/lib/xterm.js $out/xterm.js
  cp unpack/package/css/xterm.css $out/xterm.css
  rm -r unpack/package

  tar -xzf ${xtermPty} -C unpack
  cp unpack/package/index.js $out/xterm-pty.js
  rm -r unpack/package

  tar -xzf ${xzwasm} -C unpack
  cp unpack/package/dist/package/xzwasm.min.js $out/xzwasm.js
  rm -r unpack/package

  tar -xzf ${fzstd} -C unpack
  cp unpack/package/umd/index.js $out/fzstd.js
  rm -r unpack/package

  tar -xzf ${coi} -C unpack
  cp unpack/package/coi-serviceworker.min.js $out/coi-serviceworker.js
''
