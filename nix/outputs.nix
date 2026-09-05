# nixpkgs-multiverse's sibling-output map, sharded for the browser.
#
# The multiverse index publishes a package's *default* output, and
# nixpkgs splits many packages so the programs live in another one —
# `jq`'s default output holds a library and a man page. The digests of
# the siblings are in a release artifact the browser cannot read, since
# GitHub release downloads send no CORS header, so it is fetched here
# at build time and served same-origin (tools/shard-outputs.py).
#
# Pinned to the same dated tag the multiverse pins its own consumers
# to. A newer tag is a deliberate bump, not a silent one.
{ pkgs }:
let
  tag = "data-20260903";
  system = "x86_64-linux";

  # An index *of* store paths, so the reference scan has to be off;
  # fetch-artifact.nix explains why.
  artifact = import ./fetch-artifact.nix { inherit pkgs; } {
    url = "https://github.com/fzakaria/nixpkgs-multiverse/releases/download/${tag}/outs-${system}.json";
    hash = "sha256-x49u5c4fr/hxKBxXzRMrwpIQpGkUxvYW2CHWwc/AjYE=";
  };
in
pkgs.runCommand "trynix-outputs" { nativeBuildInputs = [ pkgs.python3 ]; } ''
  mkdir -p $out
  python3 ${../tools/shard-outputs.py} ${artifact} $out
''
