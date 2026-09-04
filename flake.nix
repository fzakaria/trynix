{
  description = "Boot anything nixpkgs ever shipped, in your browser";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f system);
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        rec {
          # the static site: everything the pages workflow deploys and
          # `nix run .#serve` tests locally
          site = import ./nix/site.nix { inherit pkgs self; };
          default = site;
        }
      );

      apps = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          # serve the built site locally, exactly the tree pages deploys.
          # `nix run .#serve -- <port>` overrides the default 8137. The
          # handler sends no-store: store paths carry a 1970 mtime, so a
          # plain http.server answers If-Modified-Since with 304 and the
          # browser keeps a previous build's JS forever.
          serve = {
            type = "app";
            program = "${pkgs.writeShellScript "serve-site" ''
              exec ${pkgs.python3}/bin/python3 - "''${1:-8137}" <<'EOF'
              import http.server, os, sys

              os.chdir("${self.packages.${system}.site}")

              class NoStore(http.server.SimpleHTTPRequestHandler):
                  def end_headers(self):
                      self.send_header("Cache-Control", "no-store")
                      super().end_headers()

              port = int(sys.argv[1])
              print(f"serving on http://127.0.0.1:{port}/  (Cache-Control: no-store)", flush=True)
              http.server.ThreadingHTTPServer(("", port), NoStore).serve_forever()
              EOF
            ''}";
          };
        }
      );

      checks = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          # the site assembles: the entry page and the hashed module tree
          # are where the build put them
          site = pkgs.runCommand "trynix-site-check" { } ''
            test -f ${self.packages.${system}.site}/index.html
            test -f ${self.packages.${system}.site}/js.*/app.js
            touch $out
          '';

          # the node test suite: the narinfo parser against a fixture,
          # offline
          tests = pkgs.runCommand "trynix-tests" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
            cd ${self}
            node --test tests/site/*.test.mjs
            touch $out
          '';
        }
      );

      formatter = forAllSystems (
        system:
        import ./nix/formatter.nix {
          pkgs = nixpkgs.legacyPackages.${system};
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs
              pkgs.jq
            ];
          };
        }
      );
    };
}
