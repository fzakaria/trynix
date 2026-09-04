# `nix fmt`. The tree wrapper, matching nixpkgs-multiverse and grail: one
# formatting step covers every language in the tree. prettier for the
# site's JS and CSS, and for markdown at the width the docs are written
# to.
{ pkgs }:
pkgs.nixfmt-tree.override {
  runtimeInputs = [
    pkgs.prettier
  ];
  settings = {
    formatter.prettier = {
      command = "prettier";
      options = [ "--write" ];
      includes = [
        "*.js"
        "*.mjs"
        "*.css"
      ];
    };
    # proseWrap stays at its default of preserving the author's line
    # breaks: these files are hand-wrapped prose, and reflowing would make
    # every future diff a whole-file diff.
    formatter.prettier-markdown = {
      command = "prettier";
      options = [
        "--write"
        "--print-width"
        "80"
      ];
      includes = [ "*.md" ];
    };
  };
}
