# A check on the SPIR-V passes trynix's kwvk patches add
# (patches/kwvk/0002, 0003 and 0005): tests/kwvk/harness.c includes the
# patched icd.c whole and runs the passes on modules glslang compiles
# from tests/kwvk/shaders/, and tests/kwvk/spirv-test.py checks what
# comes out with spirv-val and spirv-dis. The harness is built for the
# system running the check, not the guest: the passes are plain C over
# words in memory, and run the same on either.
{ pkgs, kwvk }:
let
  tests = ../tests/kwvk;
in
pkgs.runCommandCC "trynix-kwvk-spirv-check"
  {
    nativeBuildInputs = [
      pkgs.glslang
      pkgs.python3
      pkgs.spirv-tools
    ];
  }
  ''
    src=${kwvk.source}/vk/icd
    cc -O1 -w -I ${kwvk.headers} -I $src -D_GNU_SOURCE -DICD_C="\"$src/icd.c\"" \
      -o harness ${tests}/harness.c $src/link.c $src/wsi.c -lpthread -ldl -lm
    mkdir work
    python3 ${tests}/spirv-test.py ./harness ${tests}/shaders work
    touch $out
  ''
