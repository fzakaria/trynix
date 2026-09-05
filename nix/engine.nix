# The qemu-wasm engine and the migration snapshot, fetched from one of
# this repository's dated engine releases and pinned by hash in
# engine-pins.json.
#
# They are not built here: the engine needs docker and a pinned
# emscripten SDK, and the snapshot needs a native build of the same
# fork (docs/engine.md). Pinning them as fetches is what lets
# `nix build .#site` still produce the entire deployable tree, so the
# pages workflow only has to upload what nix built.
#
# A release tag is never reused: tools/publish-engine.py creates a new
# one per publish and rewrites the pins in the same step, so an older
# commit still resolves the bytes it was pinned to.
{ pkgs }:
let
  pins = builtins.fromJSON (builtins.readFile ./engine-pins.json);

  # The snapshot is a RAM image of a guest whose filesystem is the nix
  # store, so it is full of store paths and needs the reference scan
  # turned off; fetch-artifact.nix explains why.
  fetchArtifact = import ./fetch-artifact.nix { inherit pkgs; };

  fetch =
    name: hash:
    fetchArtifact {
      url = "${pins.baseUrl}/${pins.tag}/${name}";
      inherit hash;
    };
in
pkgs.runCommand "trynix-engine" { } ''
  mkdir -p $out
  ${pkgs.lib.concatStringsSep "\n" (
    pkgs.lib.mapAttrsToList (name: hash: "cp ${fetch name hash} $out/${name}") pins.files
  )}
''
