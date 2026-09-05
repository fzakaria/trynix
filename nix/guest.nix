# The guest image the browser VM boots: a Linux kernel built from the
# qemu-wasm fork's proven config, a busybox initramfs whose init mounts
# the 9p store share and execs a shell on the serial console, and the
# four SeaBIOS/option-ROM blobs QEMU's -L directory must hold. One image
# serves every package selection — the selection rides the 9p share.
{ pkgs }:
let
  # Pin the blobs to the same fork commit the wasm build comes from, so
  # firmware and QEMU agree.
  qemuWasmRev = "0ef7b4e2814b231705d8371dd7997f5b72e70baf";

  biosFile =
    name: sha256:
    pkgs.fetchurl {
      url = "https://raw.githubusercontent.com/ktock/qemu-wasm/${qemuWasmRev}/pc-bios/${name}";
      inherit sha256;
    };

  biosFiles = {
    "bios-256k.bin" = "sha256-8dTzlgERl+uYkCllnN4lB1HMcRwza4+75vd8/g3F3Ng=";
    "vgabios-stdvga.bin" = "sha256-ZRUTUZ+eDVuZ07BRqPXGjbaemHM5tZpEHTcQaMNMFGs=";
    "kvmvapic.bin" = "sha256-zfBXpxsH47UrGcviEL3vpZJQ0BqYELlg9/4fmO7ZWic=";
    "linuxboot_dma.bin" = "sha256-nEniVTQMePwS5U7QQ0YrygL7f8opt8+rYv+IpTRLaVA=";
  };

  # The fork's examples boot Linux v6.1 with the vendored config; build
  # the same series at its current point release — 6.1.0 itself no
  # longer compiles under gcc 15 (C23 default vs 6.1-era bool typedefs),
  # and the stable series backported the fixes — plus initramfs support
  # the disk-root examples never needed (guest/kernel-fragment.config).
  kernel = pkgs.stdenv.mkDerivation {
    pname = "trynix-guest-kernel";
    version = "6.1.187";

    src = pkgs.fetchurl {
      url = "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.1.187.tar.xz";
      sha256 = "0av4fcw3hv4pfql85s2rirxj7hkdr2kdasj219kwl257xa57jvhv";
    };

    nativeBuildInputs = with pkgs; [
      bc
      bison
      flex
      perl
      elfutils
      openssl
      gmp
      libmpc
      mpfr
    ];

    enableParallelBuilding = true;

    # big-parallel routes the build to a beefy remote builder when one
    # is configured; harmless otherwise.
    requiredSystemFeatures = [ "big-parallel" ];

    # A kernel records when, where and by whom it was built, and prints
    # the lot in `uname -a`. Those three strings land in the bzImage, so
    # the same source compiled on two machines gives two different
    # images. That matters more here than it usually would, for the same
    # reason the initramfs below is built reproducibly: the snapshot is
    # pinned to the hash of this image, and a builder that cannot
    # reproduce it byte for byte fails checks.snapshot. Pin them.
    env = {
      KBUILD_BUILD_TIMESTAMP = "Thu Jan  1 00:00:00 UTC 1970";
      KBUILD_BUILD_USER = "trynix";
      KBUILD_BUILD_HOST = "trynix";
    };

    configurePhase = ''
      cat ${./guest/linux_x86_config} ${./guest/kernel-fragment.config} > .config
      make olddefconfig
    '';

    buildPhase = ''
      make -j$NIX_BUILD_CORES bzImage
    '';

    installPhase = ''
      mkdir -p $out
      cp arch/x86/boot/bzImage $out/bzImage
    '';
  };

  # Forces the kernel to reseed after a resume; nix/guest/reseed.c says
  # why that cannot be left to chance.
  reseed = pkgs.pkgsStatic.runCommandCC "trynix-guest-reseed" { } ''
    mkdir -p $out/bin
    $CC -O2 -static -o $out/bin/reseed ${./guest/reseed.c}
  '';

  # The initramfs: static busybox, the init script, and the mount points
  # init expects. Compressed with gzip because the kernel fragment
  # enables RD_GZIP.
  initramfs =
    pkgs.runCommand "trynix-guest-initramfs"
      {
        nativeBuildInputs = [
          pkgs.cpio
        ];
      }
      ''
        mkdir -p root/bin root/proc root/sys root/dev root/share root/tmp root/etc
        cp -a ${pkgs.pkgsStatic.busybox}/bin/. root/bin/
        chmod -R u+w root/bin
        install -m755 ${reseed}/bin/reseed root/bin/reseed
        install -m755 ${./guest/init} root/init

        # Every step below exists to make the archive byte-identical on
        # any machine, which matters more here than it usually would:
        # the migration snapshot holds this initramfs in its RAM, so an
        # image that differs between two builders cannot be resumed
        # against the published snapshot (checks.snapshot catches it).
        #
        # The sources of drift are readdir order, the timestamps on the
        # directories created just above, the builder's own uid, and —
        # the one that is easy to miss — the inode and device numbers
        # the newc format records for every entry, which are whatever
        # the builder's filesystem handed out. --reproducible zeroes
        # those; the rest is handled here.
        touch -h -d @1 $(find root -mindepth 1)
        mkdir -p $out
        (cd root && find . -mindepth 1 -print0 | LC_ALL=C sort -z |
          cpio --null --create --format=newc --quiet --reproducible --owner=+0:+0) |
          gzip -9 --no-name > $out/initramfs.cpio.gz
      '';
in
{
  inherit kernel initramfs;

  # The assembled -L directory plus kernel and initramfs: everything the
  # page feeds into MEMFS before the VM starts, and the machine
  # definition both the page and the snapshot tool start QEMU from.
  guest = pkgs.runCommand "trynix-guest" { } ''
    mkdir -p $out
    cp ${kernel}/bzImage $out/bzImage
    cp ${initramfs}/initramfs.cpio.gz $out/initramfs.cpio.gz
    cp ${./guest/machine.json} $out/machine.json
    ${pkgs.lib.concatStringsSep "\n" (
      pkgs.lib.mapAttrsToList (name: sha256: "cp ${biosFile name sha256} $out/${name}") biosFiles
    )}
  '';
}
