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

  # builtins.fetchurl rather than pkgs.fetchurl, because the snapshot
  # is a RAM image of a guest whose filesystem is the nix store: it is
  # full of literal /nix/store strings, and a fixed-output derivation
  # refuses to be built when the scanner finds those ("is not allowed
  # to refer to other store paths"). A builtin fetch stores the file
  # without scanning it. Pure: the hash is pinned.
  fetch =
    name: hash:
    builtins.fetchurl {
      url = "${pins.baseUrl}/${pins.tag}/${name}";
      sha256 = hash;
    };
in
pkgs.runCommand "trynix-engine" { } ''
  mkdir -p $out
  ${pkgs.lib.concatStringsSep "\n" (
    pkgs.lib.mapAttrsToList (name: hash: "cp ${fetch name hash} $out/${name}") pins.files
  )}
''
