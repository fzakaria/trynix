# The guest's end of the translated lane (nix/exec-stub/stub.c): a
# static binary the page writes onto the 9p share and links programs
# to, so a command typed at the VM's shell runs through the translator
# in the page instead of under emulation. Static against musl, as the
# probe is, so it is one file with no dependencies to ship.
{ pkgs }:
pkgs.pkgsStatic.stdenv.mkDerivation {
  pname = "trynix-exec";
  version = "1";

  dontUnpack = true;

  buildPhase = ''
    runHook preBuild
    $CC -O2 -static -o trynix-exec ${./exec-stub/stub.c}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 trynix-exec $out/bin/trynix-exec
    runHook postInstall
  '';
}
