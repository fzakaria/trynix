#!/usr/bin/env python3
"""Take the migration snapshot the browser resumes from.

Boots the guest on a NATIVE build of the same qemu-wasm fork the
browser engine comes from, waits for init to reach the point where it
is spinning for the store share, and writes the VM state out with
`migrate`. See docs/engine.md for building the native binary and
docs/design.md for why the snapshot is taken there.

Both ends of a migration must agree on QEMU version, machine type and
device model, which is why nixpkgs' QEMU cannot take this snapshot: it
is a different major version from the fork.
"""

import argparse
import json
import os
import socket
import subprocess
import sys
import tempfile
import time

# What init prints once the kernel is up and it is polling for the
# share. Everything expensive has happened by then, and nothing that
# depends on the share has.
READY_MARKER = b"trynix: waiting for the store"

READY_TIMEOUT_SECONDS = 120
MIGRATE_TIMEOUT_SECONDS = 300
GUEST_RAM = "512M"


def qmp(sock, command, **arguments):
    """Send one QMP command and return its reply."""
    message = {"execute": command}
    if arguments:
        message["arguments"] = arguments
    sock.sendall(json.dumps(message).encode() + b"\n")

    # Events and the reply share the stream; the reply is the object
    # carrying "return" or "error".
    buffer = b""
    while True:
        buffer += sock.recv(65536)
        while b"\n" in buffer:
            line, buffer = buffer.split(b"\n", 1)
            if not line.strip():
                continue
            reply = json.loads(line)
            if "return" in reply or "error" in reply:
                return reply


def wait_for_ready(serial_path, deadline):
    """Block until init says it is polling for the share."""
    while time.monotonic() < deadline:
        try:
            with open(serial_path, "rb") as f:
                if READY_MARKER in f.read():
                    return True
        except FileNotFoundError:
            pass
        time.sleep(0.5)
    return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--qemu", required=True, help="native qemu-system-x86_64 from the fork")
    parser.add_argument("--guest", required=True, help="the guest image directory (nix build .#guest)")
    parser.add_argument("--out", required=True, help="where to write vm.state")
    args = parser.parse_args()

    with tempfile.TemporaryDirectory() as work:
        # The share is empty on purpose: the snapshot must not depend on
        # any particular package selection.
        share = os.path.join(work, "share")
        os.mkdir(share)
        serial = os.path.join(work, "serial.log")
        monitor = os.path.join(work, "qmp.sock")

        # These arguments must match the ones the page passes, device for
        # device, or the resume rejects the stream.
        command = [
            args.qemu,
            "-nographic",
            "-m", GUEST_RAM,
            "-accel", "tcg,tb-size=500",
            "-L", f"{args.guest}/",
            "-nic", "none",
            "-kernel", f"{args.guest}/bzImage",
            "-initrd", f"{args.guest}/initramfs.cpio.gz",
            "-virtfs", f"local,path={share},mount_tag=store0,security_model=none,id=store0",
            "-append", "console=ttyS0 rdinit=/init loglevel=4",
            "-serial", f"file:{serial}",
            "-qmp", f"unix:{monitor},server,nowait",
        ]

        print(" ".join(command), flush=True)
        vm = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

        try:
            deadline = time.monotonic() + READY_TIMEOUT_SECONDS
            if not wait_for_ready(serial, deadline):
                vm.kill()
                sys.exit(f"guest never reached the ready marker; see {serial}")
            print("guest is up and waiting for the store", flush=True)

            sock = socket.socket(socket.AF_UNIX)
            sock.connect(monitor)
            sock.recv(65536)  # the greeting
            qmp(sock, "qmp_capabilities")

            # Stopping first keeps the snapshot from racing the guest's
            # own poll loop while the state is written.
            qmp(sock, "stop")
            reply = qmp(sock, "migrate", uri=f"file:{args.out}")
            if "error" in reply:
                sys.exit(f"migrate failed: {reply['error']}")

            deadline = time.monotonic() + MIGRATE_TIMEOUT_SECONDS
            while time.monotonic() < deadline:
                status = qmp(sock, "query-migrate")["return"]["status"]
                if status == "completed":
                    break
                if status in ("failed", "cancelled"):
                    sys.exit(f"migration {status}")
                time.sleep(0.5)
            else:
                sys.exit("migration did not finish in time")

            qmp(sock, "quit")
        finally:
            vm.terminate()
            try:
                vm.wait(timeout=10)
            except subprocess.TimeoutExpired:
                vm.kill()

    size = os.path.getsize(args.out)
    print(f"wrote {args.out} ({size / 1024 / 1024:.1f} MiB)", flush=True)


if __name__ == "__main__":
    main()
