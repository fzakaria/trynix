{
  # A package that exists in no cache but the one next to it: GNU hello
  # with its greeting changed. It stands in for whatever you have just
  # built and want someone else to run — a branch, a patch, a review.
  #
  # Built and published into ../../site/examples/cache by
  # `nix run .#make-example-cache`, which is what trynix.dev serves.
  description = "GNU hello, patched, for the shared-cache example";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      pkgs = nixpkgs.legacyPackages.x86_64-linux;
    in
    {
      packages.x86_64-linux.default = pkgs.hello.overrideAttrs {
        pname = "hello-trynix";

        postPatch = ''
          substituteInPlace src/hello.c \
            --replace-fail 'Hello, world!' 'Hello from a tab near you!'
        '';

        # hello's own test suite asserts the greeting this patch changes.
        doCheck = false;
      };
    };
}
