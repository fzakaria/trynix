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
#
# It also checks that drivers.json's paths are exactly the store paths
# the cache has narinfos for. The page asks the site for those paths and
# no others (site/js/substituters.js), so a path missing from the list
# is fetched from nowhere, and a listed path with no narinfo is a 404.
# Each one needs its NAR listing beside it too: every guest is linked to
# the driver, and without a listing a lookup of a name in it, as any
# libglvnd program's loader makes in /run/opengl-driver/lib, downloads
# the whole NAR (site/js/lazy.js).
#
# And that the site serves the driver nix/mesa-virgl.nix builds today:
# `mesa` is packages.aarch64-linux.mesa-virgl, and a change to its
# derivation (a patch, an option, a nixpkgs bump) that was never
# published with tools/make-gl-cache.py leaves the site serving the
# old one.
{ pkgs, mesa }:
let
  gl = ../site/gl;
  inherit ((builtins.fromJSON (builtins.readFile (gl + "/drivers.json")))) paths drivers;

  # The path as a string alone: the check compares it with the pins and
  # must not build an aarch64 Mesa to do so.
  built = builtins.unsafeDiscardStringContext mesa.outPath;
  pinned = map (driver: driver.storePath) drivers;

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
    listed=$(printf '%s\n' ${pkgs.lib.escapeShellArgs paths} | sort)
    served=$(sed -n 's/^StorePath: //p' ${gl}/cache/*.narinfo | sort)
    if [ "$listed" != "$served" ]; then
      echo "drivers.json's paths are not the store paths site/gl/cache serves:" >&2
      diff <(echo "$listed") <(echo "$served") >&2 || true
      exit 1
    fi

    for narinfo in ${gl}/cache/*.narinfo; do
      if [ ! -f "''${narinfo%.narinfo}.ls" ]; then
        echo "$(basename "$narinfo") has no NAR listing beside it:" >&2
        echo "publish the driver with nix run .#make-gl-cache" >&2
        exit 1
      fi
    done

    ${pkgs.lib.optionalString (!builtins.elem built pinned) ''
      echo "nix/mesa-virgl.nix builds ${built}, which site/gl does not serve:" >&2
      echo "publish it with nix run .#make-gl-cache" >&2
      exit 1
    ''}

    ${pkgs.lib.concatMapStringsSep "\n" checkDriver drivers}
    touch $out
  ''
