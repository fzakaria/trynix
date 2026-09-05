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

# The kernel calibrates its TSC against the PIT during boot, and under
# emulation that calibration sometimes fails. The kernel then marks the
# TSC unstable and falls back to refined-jiffies, whose 10 ms resolution
# pushes clock_gettime out of the vDSO and into a real syscall. A
# snapshot freezes whichever clocksource the boot settled on, so a bad
# boot published once makes every visitor resume onto it -- which is
# what happened to the engine-20260905-0359 release. The boot is a
# lottery, so the fix is to refuse to snapshot a losing ticket.
#
# The kernel's own clocksource messages cannot be used for this: the
# machine boots with loglevel=4, which keeps everything below an error
# off the console. init prints the name instead (nix/guest/init).
CLOCKSOURCE_PREFIX = b"trynix: clocksource "
CLOCKSOURCE_GOOD = b"tsc"
CLOCKSOURCE_TIMEOUT_SECONDS = 60

# The machine definition the guest image carries (nix/guest/machine.json):
# the page starts QEMU from the same file, which is what keeps the two
# ends of the migration identical.
MACHINE_FILE = "machine.json"


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


def clocksource_complaint(serial_path, deadline):
    """Return why the guest's clocksource is unusable, or None if it is fine."""
    while time.monotonic() < deadline:
        try:
            with open(serial_path, "rb") as f:
                log = f.read()
        except FileNotFoundError:
            log = b""

        at = log.find(CLOCKSOURCE_PREFIX)
        if at != -1:
            name = log[at + len(CLOCKSOURCE_PREFIX):].split(b"\n", 1)[0].strip()
            # tsc-early counts: the TSC is working and the kernel
            # promotes it to plain tsc on its own. A jiffies fallback
            # means the calibration failed.
            if CLOCKSOURCE_GOOD in name:
                return None
            return name.decode(errors="replace")
        time.sleep(0.5)

    return "init never named a clocksource"


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

        # The machine is the page's, argument for argument, or the
        # resume rejects the stream. No -serial is added: -nographic
        # already puts the console on stdio, and a second serial backend
        # would give the snapshot a device layout the browser cannot
        # reproduce. The console is read by capturing stdout instead.
        with open(os.path.join(args.guest, MACHINE_FILE)) as f:
            machine = json.load(f)
        command = [
            args.qemu,
            *(
                arg.format(pack=args.guest, share=share, ram=machine["ram"])
                for arg in machine["args"]
            ),
            "-qmp", f"unix:{monitor},server,nowait",
        ]

        print(" ".join(command), flush=True)
        with open(serial, "wb") as console:
            vm = subprocess.Popen(command, stdout=console, stderr=subprocess.STDOUT)

        try:
            deadline = time.monotonic() + READY_TIMEOUT_SECONDS
            if not wait_for_ready(serial, deadline):
                vm.kill()
                sys.exit(f"guest never reached the ready marker; see {serial}")
            print("guest is up and waiting for the store", flush=True)

            # Snapshotting a guest that lost its TSC would publish that
            # loss to every visitor, so fail and let the caller retry.
            deadline = time.monotonic() + CLOCKSOURCE_TIMEOUT_SECONDS
            complaint = clocksource_complaint(serial, deadline)
            if complaint is not None:
                vm.kill()
                sys.exit(
                    f"this boot lost the tsc clocksource ({complaint}); a snapshot "
                    f"would freeze that in for every visitor. Run again; see {serial}"
                )
            print("guest settled on the tsc clocksource", flush=True)

            sock = socket.socket(socket.AF_UNIX)
            sock.connect(monitor)
            sock.recv(65536)  # the greeting
            qmp(sock, "qmp_capabilities")

            # Migrate the guest while it is running. Stopping it first
            # would record a paused runstate, and the browser would
            # resume into a VM that never runs a single instruction —
            # with no monitor on that side to say `cont`.
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
