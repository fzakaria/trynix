# kwvk, unkernel's guest Vulkan driver (docs/gui.md, "Vulkan
# programs"), built from source with the patches trynix carries
# (patches/kwvk/), which the site serves in place of the driver in the
# kernel's base system.
#
# The driver sends a program's Vulkan calls to the renderer in the
# unkernel SDK on the page, so the two speak one protocol: the source is
# the commit the vendored SDK release was published from
# (nix/vendor.nix), and vendor.nix takes its version from here.
#
# Built the way unkernel's vk/icd/build.sh builds it for the guest: zig
# cc for aarch64 against glibc 2.36's symbols, stripped, against the
# Vulkan headers unkernel pins (vk/pins.sh). Zig cross-compiles from
# whatever system builds the site, as it does the relay
# (nix/wlandr.nix). Without the patches this build gives the base
# system's driver byte for byte.
{ pkgs }:
let
  version = "0.2.0-261124-75694e2";
  rev = "75694e278fa9e32427251bdc31b755cce6851036";

  # The guest's CPU and C library, as vk/icd/build.sh names them.
  target = "aarch64-linux-gnu.2.36";
  cpu = "generic";

  # The Vulkan headers unkernel builds the driver against: Khronos'
  # release tag for Debian trixie's loader (vk/pins.sh).
  headersVersion = "1.4.309";
  headersTarball = pkgs.fetchurl {
    url = "https://github.com/KhronosGroup/Vulkan-Headers/archive/refs/tags/v${headersVersion}.tar.gz";
    sha256 = "437925ada160d86ed763d29dcb9318c1bb0d024d7deaf77bc7c170b8eb6b6f10";
  };

  # The headers' include directory alone: vulkan/ and vk_video/, as
  # unkernel's vk/headers.sh unpacks them.
  headers = pkgs.runCommand "vulkan-headers-${headersVersion}-include" { } ''
    mkdir -p $out
    tar -xzf ${headersTarball} -C $out --strip-components=2 \
      Vulkan-Headers-${headersVersion}/include/vulkan \
      Vulkan-Headers-${headersVersion}/include/vk_video
  '';

  # The Vulkan version the manifest says the driver speaks, and where the
  # driver and its manifest sit in the output. The page names the
  # manifest to the guest's loader by this path (site/js/vulkan.js).
  apiVersion = "1.0.314";
  library = "lib/libvulkan_kw.so";
  manifest = "share/vulkan/icd.d/kw_icd.json";

  # unkernel's source at the release's commit.
  upstream = pkgs.fetchFromGitHub {
    owner = "pithings";
    repo = "unkernel";
    inherit rev;
    sha256 = "sha256-ADiSLuaChSp3I9cfCYLIhxh8QmhxDHqdCvHglRQa9fE=";
  };

  # The source with trynix's patches applied, which the SPIR-V check
  # compiles natively too (nix/kwvk-check.nix). Without them GZDoom,
  # Taisei and DDNet draw nothing: GZDoom takes no device without
  # multiDrawIndirect, then its pipelines fail on a writable storage
  # buffer in a vertex stage, an unwritten binding and a 252-byte
  # uniform block; Taisei's on an unwritten binding, OpLine among the
  # types and a copy of part of a compressed block; DDNet finds no
  # HOST_CACHED memory to map. Each is filed as pithings/unkernel#32.
  source = pkgs.applyPatches {
    name = "kwvk-${version}-source";
    src = upstream;
    patches = [
      ../patches/kwvk/0001-report-multidrawindirect.patch
      ../patches/kwvk/0002-make-storage-buffers-never-written-read-only.patch
      ../patches/kwvk/0003-drop-descriptor-bindings-no-function-uses.patch
      ../patches/kwvk/0004-size-uniform-bindings-in-whole-16-byte-steps.patch
      ../patches/kwvk/0005-drop-opline-and-opnoline.patch
      ../patches/kwvk/0006-copy-compressed-images-in-whole-blocks.patch
      ../patches/kwvk/0007-mark-host-visible-memory-host-cached.patch
    ];
  };
in
assert pkgs.lib.hasSuffix (builtins.substring 0 7 rev) version;
pkgs.stdenvNoCC.mkDerivation {
  pname = "kwvk";
  inherit version;
  src = source;

  nativeBuildInputs = [ pkgs.zig ];

  # vk/icd/build.sh's guest build, without its test programs. The
  # sources are named by absolute path and the prefix map strips it, as
  # build.sh does from its checkout, so the binary names no build
  # directory.
  buildPhase = ''
    runHook preBuild
    export ZIG_GLOBAL_CACHE_DIR=$TMPDIR/zig-cache
    zig cc -target ${target} -mcpu=${cpu} "-ffile-prefix-map=$PWD/=" \
      -O2 -g0 -Wall -Wextra -Wno-unused-parameter -fPIC -fvisibility=hidden \
      -I ${headers} -D_GNU_SOURCE -s \
      -shared -Wl,-soname,libvulkan_kw.so -o libvulkan_kw.so \
      $PWD/vk/icd/icd.c $PWD/vk/icd/link.c $PWD/vk/icd/wsi.c -lpthread -ldl -lm
    runHook postBuild
  '';

  # The driver, and the manifest that names it to the Vulkan loader by
  # its store path.
  installPhase = ''
    runHook preInstall
    install -Dm755 libvulkan_kw.so $out/${library}
    mkdir -p $(dirname $out/${manifest})
    cat > $out/${manifest} <<EOF
    {
        "file_format_version": "1.0.0",
        "ICD": {
            "library_path": "$out/${library}",
            "api_version": "${apiVersion}"
        }
    }
    EOF
    runHook postInstall
  '';

  passthru = {
    inherit source headers manifest;
  };

  meta.license = pkgs.lib.licenses.gpl2Plus;
}
