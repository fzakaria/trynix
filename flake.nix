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

          # the guest image the browser VM boots: kernel, initramfs and
          # the BIOS blobs (nix/guest.nix)
          inherit (import ./nix/guest.nix { inherit pkgs; })
            kernel
            initramfs
            guest
            ;
        }
      );

      apps = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          # serve the site locally with the overlays a boot needs: the
          # guest image under guest/, and the out-of-band qemu engine
          # artifacts under qemu/ ($TRYNIX_QEMU_DIR, defaulting to
          # vendor/qemu-wasm in the working directory). Sends real
          # COOP/COEP headers, so SharedArrayBuffer works without the
          # service-worker shim. `nix run .#serve -- <port>` overrides
          # the default 8137. no-store because store paths carry a 1970
          # mtime, and a 304 would keep a previous build's JS forever.
          serve = {
            type = "app";
            program = "${pkgs.writeShellScript "serve-site" ''
              exec ${pkgs.python3}/bin/python3 - "''${1:-8137}" <<'EOF'
              import http.server, os, sys, urllib.parse

              SITE = "${self.packages.${system}.site}"
              GUEST = "${self.packages.${system}.guest}"
              QEMU = os.environ.get(
                  "TRYNIX_QEMU_DIR", os.path.join(os.getcwd(), "vendor/qemu-wasm")
              )

              class Handler(http.server.SimpleHTTPRequestHandler):
                  def translate_path(self, path):
                      path = urllib.parse.urlparse(path).path
                      for prefix, root in (("/qemu/", QEMU), ("/guest/", GUEST)):
                          if path.startswith(prefix):
                              return os.path.join(root, path[len(prefix):])
                      if path == "/":
                          path = "/index.html"
                      return os.path.join(SITE, path.lstrip("/"))

                  def end_headers(self):
                      self.send_header("Cache-Control", "no-store")
                      self.send_header("Cross-Origin-Opener-Policy", "same-origin")
                      self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
                      super().end_headers()

              port = int(sys.argv[1])
              print(f"serving on http://127.0.0.1:{port}/ (site={SITE}, qemu={QEMU})", flush=True)
              http.server.ThreadingHTTPServer(("", port), Handler).serve_forever()
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
