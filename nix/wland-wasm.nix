# wland's compositor core as wasm, which the page runs for GUI programs
# in the unkernel guest (docs/gui.md), built from the source and with
# the patches the relay is built from (nix/wlandr.nix).
#
# The npm release (nix/vendor.nix) carries this wasm prebuilt, and its
# browser modules are still taken from there. trynix carries a patch to
# the core (patches/wland/), which a prebuilt wasm cannot take, so the
# wasm is built here. wland's build writes it into the source tree
# (lib/wland.wasm, which upstream commits) whatever the install prefix;
# from the unpatched source this build gives the npm release's wasm
# byte for byte.
{ pkgs }:
let
  relay = import ./wlandr.nix { inherit pkgs; };
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "wland-wasm";
  inherit (relay) version src patches;

  nativeBuildInputs = [ pkgs.zig ];

  # The wasm is always ReleaseSmall (build.zig). The relay the default
  # install step also builds, for the build machine, is not kept.
  buildPhase = ''
    runHook preBuild
    export ZIG_GLOBAL_CACHE_DIR=$TMPDIR/zig-cache
    zig build \
      -Dhttp=false \
      -Dsession=false \
      -Dversion=$version \
      --prefix $TMPDIR/out
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm644 lib/wland.wasm $out/wland.wasm
    runHook postInstall
  '';

  meta.license = pkgs.lib.licenses.mpl20;
}
