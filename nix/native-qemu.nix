# The native qemu-system-x86_64 that takes the migration snapshot
# (tools/make-snapshot.py). Both ends of a migration must agree on
# QEMU version, machine type and devices, so nixpkgs' QEMU cannot stand
# in for the 8.2-based fork the engine is built from.
#
# Built from the same fork commit and the same patches/ as the engine,
# as a derivation, so it changes whenever they do. It used to be a
# docker build kept in vendor/qemu-native and reused by hand, which is
# how a binary from before patches/0003 took two snapshots whose guest
# clock ran three times slow (docs/engine.md). 0003 matters here: it
# makes this build count the monotonic clock the WebAssembly build
# counts, so the guest calibrates its TSC against the clock it will
# actually run on.
{ pkgs }:
let
  inherit (pkgs) lib;

  # The pinned fork commit, the same one nix/guest.nix takes the BIOS
  # blobs from and tools/build-engine.sh builds the engine from.
  qemuWasmRev = "0ef7b4e2814b231705d8371dd7997f5b72e70baf";

  src = pkgs.fetchFromGitHub {
    owner = "ktock";
    repo = "qemu-wasm";
    rev = qemuWasmRev;
    hash = "sha256-7tXHhucQnJPQSGV1KK8cC+8QeVRVLSUYU9v9fkm9N2I=";
  };

  # The meson wrap subprojects the build evaluates, at the revisions
  # the fork's subprojects/*.wrap files name, fetched here because the
  # build sandbox has no network. keycodemapdb is what the target uses;
  # the two softfloat trees only feed tests/fp, which is never built,
  # but meson reads their build files at setup.
  wrap =
    name: rev: hash:
    pkgs.fetchgit {
      url = "https://gitlab.com/qemu-project/${name}.git";
      inherit rev hash;
    };
  subprojects = {
    keycodemapdb =
      wrap "keycodemapdb" "f5772a62ec52591ff6870b7e8ef32482371f22c6"
        "sha256-EQrnBAXQhllbVCHpOsgREzYGncMUPEIoWFGnjo+hrH4=";
    berkeley-softfloat-3 =
      wrap "berkeley-softfloat-3" "b64af41c3276f97f0e181920400ee056b9c88037"
        "sha256-Yflpx+mjU8mD5biClNpdmon24EHg4aWBZszbOur5VEA=";
    berkeley-testfloat-3 =
      wrap "berkeley-testfloat-3" "e7af9751d9f9fd3b47911f51a5cfd08af256a9ab"
        "sha256-inQAeYlmuiRtZm37xK9ypBltCJ+ycyvIeIYZK8a+RYU=";
  };

  # Every numbered patch, in order: the same series the engine gets.
  patchDir = ../patches;
  patches = map (name: patchDir + "/${name}") (
    builtins.sort builtins.lessThan (
      builtins.filter (name: lib.hasSuffix ".patch" name) (builtins.attrNames (builtins.readDir patchDir))
    )
  );

  # configure builds itself a venv and wants distlib in the python it
  # is given, rather than downloading one.
  python = pkgs.python3.withPackages (ps: [ ps.distlib ]);
in
pkgs.stdenv.mkDerivation {
  pname = "trynix-native-qemu";
  version = "8.2.0-${builtins.substring 0 8 qemuWasmRev}";
  inherit src patches;

  nativeBuildInputs = with pkgs; [
    pkg-config
    meson
    ninja
    python
    perl
    bison
    flex
  ];
  buildInputs = with pkgs; [
    glib
    pixman
    libffi
    attr
    zlib
    # libfdt: without a git tree to fetch the dtc subproject into,
    # configure asks for the system library
    dtc
  ];

  # Put each subproject where its wrap would have downloaded it, and lay
  # the wrap's packagefiles overlay (the meson.build QEMU carries for it)
  # on top, which meson only does for trees it fetched itself.
  postPatch = lib.concatStrings (
    lib.mapAttrsToList (name: tree: ''
      cp -r ${tree} subprojects/${name}
      chmod -R u+w subprojects/${name}
      if [ -d subprojects/packagefiles/${name} ]; then
        cp -r subprojects/packagefiles/${name}/. subprojects/${name}/
      fi
    '') subprojects
  );

  # The configure line of the docker recipe this replaces, minus
  # --static (the binary runs on nix hosts), with ninja and python
  # named and downloads refused, so configure takes the meson on PATH.
  configurePhase = ''
    runHook preConfigure
    ./configure --prefix=$out --target-list=x86_64-softmmu \
      --without-default-features --enable-system --with-coroutine=ucontext \
      --enable-virtfs --enable-attr \
      --extra-cflags=-DQEMU_GENERIC_HOST_TICKS \
      --ninja=ninja --python=${python}/bin/python3 --disable-download --disable-docs
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    make -j$NIX_BUILD_CORES qemu-system-x86_64
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 build/qemu-system-x86_64 $out/bin/qemu-system-x86_64
    runHook postInstall
  '';
}
