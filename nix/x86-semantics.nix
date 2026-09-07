# The translator's semantics fixture: every instruction form the
# translator implements, run on the build machine's own processor from
# random states by tools/x86-semantics, with the state the hardware
# leaves recorded for tests/x86/semantics.test.mjs to replay. The
# harness executes native x86-64 code, so this derivation only makes
# sense on x86_64-linux and the result depends on the CPU it ran on;
# it is not meant to be substituted.
{ pkgs }:
pkgs.runCommand "trynix-x86-semantics"
  {
    nativeBuildInputs = [
      pkgs.python3
      pkgs.gcc
      pkgs.binutils
    ];
    preferLocalBuild = true;
    allowSubstitutes = false;
  }
  ''
    python3 ${../tools/x86-semantics/generate.py} $out
  ''
