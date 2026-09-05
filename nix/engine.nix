# The qemu-wasm engine and the migration snapshot, fetched from this
# repository's `engine` release and pinned by hash in engine-pins.json.
#
# They are not built here: the engine needs docker and a pinned
# emscripten SDK, and the snapshot needs a native build of the same
# fork (docs/engine.md). Pinning them as fetches is what lets
# `nix build .#site` still produce the entire deployable tree, so the
# pages workflow only has to upload what nix built.
#
# A tag whose assets were replaced in place would fail these hashes,
# which is the intended behaviour: publish new artifacts, then update
# the pins in the same commit.
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
