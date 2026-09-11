{
  description = "Boot anything nixpkgs ever shipped, in your browser";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  # The guest kernel is the one expensive build in this flake; the cache
  # means a contributor (and CI) fetches it rather than compiling it.
  nixConfig = {
    extra-substituters = [ "https://trynix.cachix.org" ];
    extra-trusted-public-keys = [
      "trynix.cachix.org-1:xmOWOHz2g/BlpCVQrTEZjSKWPk3S3Dukn1xiSWLidkY="
    ];
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
          site = import ./nix/site.nix { inherit pkgs; };
          default = site;

          # the CPU probe tools/cpu-test.py boots inside the guest to
          # check the emulator's arithmetic (nix/probe.nix)
          probe = import ./nix/probe.nix { inherit pkgs; };

          # the throughput probe tools/emubench.py runs the same way, to
          # put a number on each instruction class (nix/emubench.nix)
          emubench = import ./nix/emubench.nix { inherit pkgs; };

          # the same probe for the baseline x86-64 ISA, so the benchmark
          # history can run one instrument on engines whose guest CPU
          # predates x86-64-v3 (tools/bench-history.py)
          emubench-baseline = import ./nix/emubench.nix {
            inherit pkgs;
            march = "x86-64";
          };

          # SCOTT and Chinook as SQLite databases, published to
          # trynix.cachix.org so a link can boot them next to sqlite
          # (nix/example-dbs.nix)
          example-dbs = import ./nix/example-dbs.nix { inherit pkgs; };

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

          # The engine tools (docs/engine.md), each a command with its
          # dependencies on PATH: `nix run .#<name> -- <arguments>`.
          # docker is the host's; the client here only talks to it.
          tool = name: script: runtimeInputs: {
            type = "app";
            program = "${
              pkgs.writeShellApplication {
                inherit name runtimeInputs;
                text = ''
                  export TRYNIX_PATCHES=${./patches}
                  exec ${script} "$@"
                '';
              }
            }/bin/${name}";
          };
        in
        {
          # build the qemu-wasm engine from a checkout of the fork
          build-engine = tool "build-engine" ./tools/build-engine.sh [
            pkgs.docker
            pkgs.rsync
            pkgs.gnupatch
          ];

          # build the native QEMU the snapshot is taken on
          build-native-qemu = tool "build-native-qemu" ./tools/build-native-qemu.sh [
            pkgs.docker
            pkgs.rsync
          ];

          # take the migration snapshot: --qemu, --guest, --out
          make-snapshot = tool "make-snapshot" "${pkgs.python3}/bin/python3 ${./tools/make-snapshot.py}" [ ];

          # boot the built site in a real browser, repeatedly, and fail
          # if the guest does not reach a shell
          boot-test =
            let
              python = pkgs.python3.withPackages (ps: [ ps.websocket-client ]);
            in
            tool "boot-test" "${python}/bin/python3 ${./tools/boot-test.py}" [
              pkgs.chromium
            ];

          # boot the CPU probe in a real browser and check that the
          # emulator computes what the hardware would
          cpu-test =
            let
              python = pkgs.python3.withPackages (ps: [ ps.websocket-client ]);
            in
            tool "cpu-test" "${python}/bin/python3 ${./tools/cpu-test.py}" [
              pkgs.chromium
            ];

          # run the throughput probe in a real browser and print what each
          # instruction class costs; --engine compares a local engine.
          # The tools directory as a whole, since this imports cpu-test.py
          emubench =
            let
              python = pkgs.python3.withPackages (ps: [ ps.websocket-client ]);
            in
            tool "emubench" "${python}/bin/python3 ${./tools}/emubench.py" [
              pkgs.chromium
            ];

          # run a few real packages cold and warm in fresh guests and
          # report wall time, guest CPU, browser CPU and memory, with
          # ratios against an earlier run's --json
          exec-bench =
            let
              python = pkgs.python3.withPackages (ps: [ ps.websocket-client ]);
            in
            tool "exec-bench" "${python}/bin/python3 ${./tools}/exec-bench.py" [
              pkgs.chromium
            ];

          # compose a trynix link for a flake attribute already in some
          # cache, so a build someone published is a link they can send.
          # This is what the GitHub action in action/ runs; nix is not a
          # runtime input, because the caller's nix is the one that
          # should evaluate the caller's flake.
          share-link = tool "share-link" "${pkgs.python3}/bin/python3 ${./tools/share-link.py}" [ ];

          # measure every published engine on this machine and write the
          # history the site's benchmark page draws (site/bench/). git and
          # nix are for building the site at each commit that repinned.
          bench-history =
            let
              python = pkgs.python3.withPackages (ps: [ ps.websocket-client ]);
            in
            tool "bench-history" "${python}/bin/python3 ${./tools}/bench-history.py" [
              pkgs.chromium
              pkgs.git
              pkgs.nix
            ];

          # publish the example package into the site as a binary cache
          make-example-cache = tool "make-example-cache" ./tools/make-example-cache.sh [
            pkgs.curl
            pkgs.git
            pkgs.nix
          ];

          # publish engine and snapshot as a dated release and repin.
          # git is here to find the checkout whose pins are rewritten:
          # run this way the script itself sits in the store, nowhere
          # near the tree that carries the commit.
          publish-engine = tool "publish-engine" "${pkgs.python3}/bin/python3 ${./tools/publish-engine.py}" [
            pkgs.gh
            pkgs.git
            pkgs.nix
          ];

          # serve the built site, exactly the tree pages deploys —
          # engine, snapshot and guest image included, since the
          # derivation carries them. $TRYNIX_QEMU_DIR overlays a
          # locally built engine over qemu/ for iterating on it, and
          # assets.json is recomputed to match.
          #
          # Sends real COOP/COEP headers, so SharedArrayBuffer works
          # without the service-worker shim. `nix run .#serve -- <port>`
          # overrides the default 8137. no-store because store paths
          # carry a 1970 mtime, and a 304 would keep a previous build's
          # JS forever.
          serve = {
            type = "app";
            program = "${pkgs.writeShellScript "serve-site" ''
              exec ${pkgs.python3}/bin/python3 - "''${1:-8137}" <<'EOF'
              import hashlib, http.server, json, os, sys, urllib.parse

              SITE = "${self.packages.${system}.site}"
              QEMU = os.environ.get("TRYNIX_QEMU_DIR")

              def digest(path):
                  h = hashlib.sha256()
                  with open(path, "rb") as f:
                      for chunk in iter(lambda: f.read(1 << 20), b""):
                          h.update(chunk)
                  return h.hexdigest()[:12]

              # With an engine overlay the manifest shipped in the site
              # describes the wrong bytes, so it is rebuilt over what is
              # actually being served.
              def assets():
                  with open(os.path.join(SITE, "assets.json")) as f:
                      manifest = json.load(f)
                  if QEMU and os.path.isdir(QEMU):
                      for name in sorted(os.listdir(QEMU)):
                          path = os.path.join(QEMU, name)
                          if os.path.isfile(path):
                              manifest["files"][f"qemu/{name}"] = digest(path)
                  return json.dumps(manifest).encode()

              ASSETS = assets()

              class Handler(http.server.SimpleHTTPRequestHandler):
                  def do_GET(self):
                      if urllib.parse.urlparse(self.path).path == "/assets.json":
                          self.send_response(200)
                          self.send_header("Content-Type", "application/json")
                          self.send_header("Content-Length", str(len(ASSETS)))
                          self.end_headers()
                          self.wfile.write(ASSETS)
                          return
                      super().do_GET()

                  def translate_path(self, path):
                      path = urllib.parse.urlparse(path).path
                      if QEMU and path.startswith("/qemu/"):
                          return os.path.join(QEMU, path[len("/qemu/"):])
                      if path == "/":
                          path = "/index.html"
                      return os.path.join(SITE, path.lstrip("/"))

                  def end_headers(self):
                      self.send_header("Cache-Control", "no-store")
                      self.send_header("Cross-Origin-Opener-Policy", "same-origin")
                      self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
                      super().end_headers()

              port = int(sys.argv[1])
              print(f"serving on http://127.0.0.1:{port}/ (site={SITE}, qemu={QEMU or 'from the site'})", flush=True)
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
          vendor = import ./nix/vendor.nix { inherit pkgs; };
        in
        {
          # the site assembles: the entry page and the hashed module tree
          # are where the build put them
          site = pkgs.runCommand "trynix-site-check" { } ''
            test -f ${self.packages.${system}.site}/index.html
            test -f ${self.packages.${system}.site}/js.*/app.js
            touch $out
          '';

          # The snapshot resumes a guest that was captured from one
          # particular kernel and initramfs, and holds them in its RAM.
          # A guest built from different sources cannot be resumed
          # against it — the VM would come back describing files that
          # are not the ones being served — so the pins record what it
          # was taken from and this fails when they drift.
          snapshot =
            let
              pins = (builtins.fromJSON (builtins.readFile ./nix/engine-pins.json)).guest;
              guest = self.packages.${system}.guest;
              matches = pkgs.lib.mapAttrsToList (name: hash: ''
                echo "${hash}  ${guest}/${name}" |
                  sed "s|sha256-|sha256-|" > expected
                got="$(nix-hash --type sha256 --sri --flat ${guest}/${name})"
                if [ "$got" != "${hash}" ]; then
                  echo "${name} is $got, but the snapshot was taken against ${hash}"
                  echo "retake the snapshot (docs/engine.md) and update nix/engine-pins.json"
                  exit 1
                fi
              '') pins;
            in
            pkgs.runCommand "trynix-snapshot-check" { nativeBuildInputs = [ pkgs.nix ]; } ''
              ${pkgs.lib.concatStringsSep "\n" matches}
              touch $out
            '';

          # the probes build; cpu-test and emubench run them in CI's browser
          probe = self.packages.${system}.probe;
          emubench = self.packages.${system}.emubench;

          # the test suites, offline: node for the site's narinfo parser
          # against a fixture, python for the benchmark tools' parsers
          #
          # A writable copy of the tree rather than the source itself,
          # so the vendored dependencies can be put where the site's
          # modules import them from — which is what lets the bzip2 test
          # drive the real decoder instead of a stand-in.
          tests =
            pkgs.runCommand "trynix-tests"
              {
                nativeBuildInputs = [
                  pkgs.nodejs
                  pkgs.python3
                ];
              }
              ''
                cp -r ${self} tree
                chmod -R u+w tree
                cd tree
                ln -s ${vendor} site/vendor
                node --test tests/site/*.test.mjs
                python3 -m unittest discover -s tests/tools -t .
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
