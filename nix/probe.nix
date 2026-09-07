# The CPU probe the browser test runs inside the guest: one static
# binary that checks the instructions a Haswell guest reaches and a
# baseline one does not (nix/probe/cputest.c).
#
# Statically linked against musl so the closure is this one path. That
# is what lets tools/cpu-test.py serve it from a binary cache of its own
# next to the page and boot with no network at all -- and it keeps the
# thing under test to the emulator, rather than a dynamic loader and a
# glibc fetched from somewhere else.
{ pkgs }:
pkgs.pkgsStatic.stdenv.mkDerivation {
  pname = "trynix-probe";
  version = "1";

  dontUnpack = true;

  # -march=haswell to match the CPU model in nix/guest/machine.json: the
  # point is to emit the instructions that model promises. The reference
  # implementations in the file are plain C and stay correct either way.
  buildPhase = ''
    runHook preBuild
    $CC -O2 -static -march=haswell -o cputest ${./probe/cputest.c}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 cputest $out/bin/cputest
    runHook postInstall
  '';
}
