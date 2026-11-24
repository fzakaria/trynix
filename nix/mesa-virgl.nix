# The GL driver the unkernel guest's programs load: nixpkgs' Mesa with
# the virgl driver alone (docs/gui.md).
#
# The guest's only GPU is unkernel's virtio-gpu device, which renders
# through virglrenderer on the page's WebGL2, so virgl is the one
# driver a program there can use. nixpkgs' Mesa builds every driver it
# can, and its closure is 380 MB compressed: LLVM for llvmpipe and the
# OpenCL frontend, python3 for two Vulkan layer scripts in bin/, and
# Vulkan, video and X11 libraries. Without them the closure is Mesa
# and a few libraries the cache already serves.
#
# `pkgs` is the aarch64-linux package set the guest's programs come
# from. Mesa is loaded into each program's process, so it has to be
# built against a glibc no newer than the program's (docs/gui.md says
# which one that is, and why).
{ pkgs }:
let
  inherit (pkgs) lib;

  # libdrm without its Intel support, which links libpciaccess, which
  # carries hwdata's PCI id tables (10 MB, 2.3 MB compressed). The
  # guest's GPU is virtio-gpu, which has no PCI ids to look up.
  libdrm = pkgs.libdrm.override { withIntel = false; };

  # libgbm against that libdrm. nixpkgs' libgbm also propagates libdrm
  # to whatever builds against it, which puts libdrm's dev and bin
  # outputs in the runtime closure of anything that links it; Mesa
  # names libdrm itself, so the propagation file is dropped.
  libgbm = (pkgs.libgbm.override { inherit libdrm; }).overrideAttrs {
    postFixup = ''
      rm $out/nix-support/propagated-build-inputs
      rmdir --ignore-fail-on-non-empty $out/nix-support
    '';
  };
in
(pkgs.mesa.override {
  inherit libdrm libgbm;
  galliumDrivers = [ "virgl" ];
  vulkanDrivers = [ ];
  vulkanLayers = [ ];
  # Wayland only: the guest has no X server. EGL's surfaceless and GBM
  # platforms are always built.
  eglPlatforms = [ "wayland" ];
  enablePatentEncumberedCodecs = false;
  withValgrind = false;
}).overrideAttrs
  (old: {
    pname = "mesa-virgl";

    # A draw that samples a texture it renders into puts the guest's
    # whole GL context in error on unkernel, whose renderer replays GL
    # on WebGL 2; the virgl driver sends a stand-in view instead, until
    # unkernel fixes its renderer (the patch's header says more).
    patches = old.patches ++ [
      ../patches/mesa/0001-virgl-stand-in-for-a-sampler-view-in-a-feedback-loop.patch
    ];

    # The OpenCL, spirv2dxil and cross-tool outputs hold nothing once
    # their drivers and tools are gone.
    outputs = [ "out" ];
    separateDebugInfo = false;

    # nixpkgs builds with meson's auto features enabled, so every
    # feature option is named here, on or off, rather than left to
    # that.
    mesonFlags = [
      "--sysconfdir=/etc"
      (lib.mesonOption "platforms" "wayland")
      (lib.mesonOption "gallium-drivers" "virgl")
      (lib.mesonOption "vulkan-drivers" "")
      (lib.mesonOption "vulkan-layers" "")
      (lib.mesonOption "video-codecs" "")
      (lib.mesonOption "tools" "")

      # What libglvnd and a Wayland EGL client need: EGL and GLES
      # through glvnd, and GBM's backend for the guest's render node.
      (lib.mesonEnable "glvnd" true)
      (lib.mesonEnable "egl" true)
      (lib.mesonEnable "gles2" true)
      (lib.mesonEnable "gbm" true)
      (lib.mesonBool "libgbm-external" true)
      (lib.mesonEnable "glx" false)

      (lib.mesonEnable "llvm" false)
      (lib.mesonBool "gallium-rusticl" false)
      (lib.mesonBool "teflon" false)
      (lib.mesonBool "gallium-extra-hud" false)
      (lib.mesonEnable "gallium-va" false)
      (lib.mesonEnable "gallium-mediafoundation" false)
      (lib.mesonEnable "microsoft-clc" false)
      (lib.mesonEnable "android-libbacktrace" false)
      (lib.mesonEnable "valgrind" false)
      (lib.mesonEnable "libunwind" false)
      (lib.mesonEnable "lmsensors" false)
      (lib.mesonEnable "intel-rt" false)
      (lib.mesonEnable "spirv-tools" false)
      (lib.mesonEnable "shared-llvm" false)
      (lib.mesonEnable "xlib-lease" false)
      (lib.mesonEnable "display-info" false)
      (lib.mesonEnable "gallium-d3d12-video" false)
      (lib.mesonEnable "gallium-d3d12-graphics" false)
      (lib.mesonEnable "android-libperfetto" false)
      (lib.mesonEnable "html-docs" false)
      (lib.mesonEnable "power8" false)
      (lib.mesonEnable "split-debug" false)

      # Kept: the shader cache, its compression, driconf's XML and the
      # file-descriptor comparison the loader uses.
      (lib.mesonEnable "shader-cache" true)
      (lib.mesonEnable "zstd" true)
      (lib.mesonEnable "zlib" true)
      (lib.mesonEnable "expat" true)
      (lib.mesonEnable "xmlconfig" true)
      (lib.mesonEnable "allow-kcmp" true)
      (lib.mesonEnable "shared-glapi" true)
      (lib.mesonEnable "gles1" true)
      (lib.mesonBool "build-tests" false)
    ];

    # LLVM, clang and the OpenCL pieces are inputs for drivers and
    # frontends this build leaves out; dropping them saves downloading
    # them to build it.
    buildInputs = builtins.filter (
      input:
      !(builtins.elem (lib.getName input) [
        "clang"
        "clang-wrapper"
        "llvm"
        "libclc"
        "mesa-libclc"
        "SPIRV-LLVM-Translator"
        "spirv-llvm-translator"
        "valgrind-light"
        "lm-sensors"
        "libunwind"
        "libva-minimal"
        "directx-headers"
      ])
    ) old.buildInputs;

    # Nothing to move to the dropped outputs.
    postInstall = "";

    # nixpkgs' fixup, less the Vulkan layer manifests and Zink's
    # libvulkan RPATH, neither of which exists here.
    postFixup = ''
      for js in $out/share/glvnd/egl_vendor.d/*.json; do
        substituteInPlace "$js" --replace-fail '"libEGL_' '"'"$out/lib/libEGL_"
      done
      rm -f $out/lib/pkgconfig/dri.pc
      for header in ${toString pkgs.mesa-gl-headers.headers}; do
        rm -f $out/$header
      done
      find $out -type d -empty -delete
    '';

    # No LLVM and no python in the closure, which are what made the
    # stock Mesa's large, and none of what the libdrm and libgbm above
    # leave out; checked when the package is built.
    disallowedRequisites = [
      pkgs.llvmPackages.libllvm.lib
      pkgs.python3
      pkgs.hwdata
      pkgs.libpciaccess
      (lib.getDev libdrm)
      (lib.getBin libdrm)
    ];
  })
