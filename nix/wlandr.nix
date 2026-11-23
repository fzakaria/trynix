# wland's relay for the unkernel guest: the program a Wayland app in
# the guest connects to, which hands the app's protocol and buffers to
# the compositor in the page over vsock (docs/gui.md).
#
# unkernel's npm package no longer carries a relay: its base system has
# none, and only unkernel's Debian image ships one. trynix boots the
# base system, so the site serves this binary and the page writes it
# into the guest's share.
#
# Built from source with Zig, cross-compiled to aarch64 from whatever
# system builds the site. Zig links no libc here, so the binary is
# static and its closure is itself. The build is wland's "link"
# flavour (`-Dhttp=false -Dsession=false`): the --link relay alone,
# without the HTTP server or the compositor a remote session hosts,
# which is the shape wland's build names for a VM guest.
{ pkgs }:
let
  # The npm release the page's compositor comes from (nix/vendor.nix):
  # the relay and the compositor speak one stream protocol, so the two
  # are pinned to the same commit.
  version = "0.1.0-261122-6617578";
  rev = "6617578ad39c1eee00fc933c5df6741c11cc539c";

  # The guest's CPU: aarch64 at the architecture's baseline, which is
  # what unkernel's emulator implements and what wland's own release
  # builds target.
  target = "aarch64-linux-musl";
  cpu = "baseline";
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "wlandr";
  inherit version;

  src = pkgs.fetchFromGitHub {
    owner = "pithings";
    repo = "wland";
    inherit rev;
    sha256 = "17lmf872z2wdrqd9akv72pjbfbfbm9gmxa7h2m4zs1f5p3a9919w";
  };

  nativeBuildInputs = [ pkgs.zig ];

  # The default install step also writes the compositor's wasm and the
  # test fixture; only the relay is kept.
  buildPhase = ''
    runHook preBuild
    export ZIG_GLOBAL_CACHE_DIR=$TMPDIR/zig-cache
    zig build \
      -Dtarget=${target} \
      -Dcpu=${cpu} \
      -Doptimize=ReleaseSmall \
      -Dhttp=false \
      -Dsession=false \
      -Dversion=${version} \
      --prefix $TMPDIR/out
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 $TMPDIR/out/bin/wlandr $out/bin/wlandr
    runHook postInstall
  '';

  meta.license = pkgs.lib.licenses.mpl20;
}
