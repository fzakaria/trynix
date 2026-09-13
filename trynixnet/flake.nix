{
  description = "Browser Ethernet and HTTP proxy for trynix";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs =
    { self, nixpkgs }:
    let
      eachSystem = nixpkgs.lib.genAttrs [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
    in
    {
      packages = eachSystem (system: {
        default = import ./package.nix { pkgs = nixpkgs.legacyPackages.${system}; };
      });
      checks = eachSystem (system: {
        default = self.packages.${system}.default;
      });
      devShells = eachSystem (system: {
        default = nixpkgs.legacyPackages.${system}.mkShell {
          packages = [ nixpkgs.legacyPackages.${system}.go ];
        };
      });
    };
}
