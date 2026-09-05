# One pinned artifact made of store paths, fetched as a derivation.
#
# Both things this repository fetches by hash are lists of, or images
# of, the nix store: the multiverse's sibling-output index is an index
# of store paths, and the migration snapshot is a RAM image of a guest
# whose filesystem is the store. Nix scans a fixed-output derivation's
# output for the hash part of every store path it knows, finds
# thousands, and refuses — "is not allowed to refer to other store
# paths".
#
# unsafeDiscardReferences is the documented way out. __structuredAttrs
# is explicit because fetchurl only sets it from 26.05 on, and the
# discard is silently ignored without it.
#
# fetchurl rather than builtins.fetchurl: a builtin fetch happens
# during evaluation, and nothing needs these bytes until a build does.
# The technique is nixpkgs-multiverse's, which fetches its own
# artifacts the same way.
{ pkgs }:
{ url, hash }:
pkgs.fetchurl {
  inherit url hash;
  derivationArgs = {
    __structuredAttrs = true;
    unsafeDiscardReferences.out = true;
  };
}
