# A check on the GL driver the site serves (site/gl/): Mesa's own
# libraries ask for no GLIBC_ symbol version newer than the floor
# drivers.json declares. The page loads the driver into a program only
# when the program's glibc is at least that floor
# (site/js/gldriver.js), so a floor set too low is a driver that fails
# to load with "version GLIBC_2.xx not found" in exactly the programs
# the page chose it for.
#
# tools/make-gl-cache.py computes the floor over Mesa's whole closure;
# this recomputes it over the NAR the site serves, from the committed
# bytes, which is what drifts if either file is edited by hand. Runs on
# any system: readelf reads aarch64 ELF files from x86_64.
{ pkgs }:
let
  gl = ../site/gl;
  inherit ((builtins.fromJSON (builtins.readFile (gl + "/drivers.json")))) drivers;

  checkDriver =
    driver:
    let
      digest = builtins.substring 11 32 driver.storePath;
    in
    ''
      url=$(sed -n 's/^URL: //p' ${gl}/cache/${digest}.narinfo)
      rm -rf unpacked
      xz -dc ${gl}/cache/$url | nix-store --restore unpacked
      needed=$(find unpacked -type f -exec sh -c \
        'readelf -h "$1" > /dev/null 2>&1 && readelf --version-info --wide "$1"' _ {} \; |
        sed -n 's/.*Name: GLIBC_\([0-9.]*\).*/\1/p' | sort -V | tail -n1)
      newest=$(printf '%s\n%s\n' "$needed" "${driver.glibc}" | sort -V | tail -n1)
      if [ "$newest" != "${driver.glibc}" ]; then
        echo "${driver.storePath} needs GLIBC_$needed, drivers.json says ${driver.glibc}" >&2
        exit 1
      fi
      echo "${driver.storePath}: needs GLIBC_$needed, declared floor ${driver.glibc}"
    '';
in
pkgs.runCommand "trynix-gl-check"
  {
    nativeBuildInputs = [
      pkgs.binutils
      pkgs.nix
      pkgs.xz
    ];
  }
  ''
    ${pkgs.lib.concatMapStringsSep "\n" checkDriver drivers}
    touch $out
  ''
