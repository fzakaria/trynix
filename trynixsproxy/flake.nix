{
  description = "SOCKS5 over WebSocket for trynix";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      eachSystem = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = eachSystem (system: {
        default = import ./package.nix {
          pkgs = nixpkgs.legacyPackages.${system};
        };
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
