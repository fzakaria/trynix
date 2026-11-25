"""Speak the Wayland protocol by hand to the relay and the page's
compositor, to check what no toolkit does on purpose. This runs inside
the unkernel guest: gui-test.py copies it there and runs it with the
guest's python3, one check a case.

    python3 wayland-probe.py <check> [<socket>]

Without a path, $XDG_RUNTIME_DIR/$WAYLAND_DISPLAY. Prints
WAYLAND-PROBE PASS once the check holds, or FAIL and why, and exits 1
on FAIL.

The checks:

    fds    sends 28 wl_shm pools, each with its own memfd, and a
           destroy for each in one write, then a wl_display.sync, and
           waits for the sync's done. libwayland queues a client's
           requests and flushes them in one sendmsg, with up to 28
           descriptors riding along (MAX_FDS_OUT in its connection.c),
           so a client that makes that many pools before it flushes
           sends them at once. libdecor's GTK plugin, which SDL
           programs draw their title bars with, makes a new pool for
           every redraw and redraws the title bar on every pointer
           motion over it: GZDoom busy loading while the reader dragged
           its title bar sent dozens of pools in one burst. A relay
           that drops some of those descriptors meets a create_pool
           without one and closes the connection, and the window is
           gone while the program runs on.
    frames asks for a frame callback on a surface with nothing on
           screen, a wl_surface with no role and no buffer, commits it,
           and checks for two seconds of roundtrips that the callback
           does not fire, nor once the surface is destroyed. weston and
           wlroots fire no frame callback of a surface that is not
           mapped. SDL 3 can lose track of one whose listener points
           at a window it frees later; GZDoom shows and destroys a
           window several times as it starts, and a done for such a
           callback crashed it.
"""

import enum
import os
import socket
import struct
import sys
import time

# The descriptors one libwayland flush carries at most, which is how
# many the fds check sends in one write.
FDS_IN_ONE_WRITE = 28

# The size of each pool, one page.
POOL_SIZE = 4096

# How long the frames check gives the compositor to fire a callback it
# should hold, which is many of the page's frames, and the time between
# its roundtrips.
HOLD_SECONDS = 2
HOLD_POLL_SECONDS = 0.1

# The protocol's fixed objects and opcodes (wayland.xml).
DISPLAY_ID = 1
DISPLAY_SYNC = 0
DISPLAY_GET_REGISTRY = 1
DISPLAY_ERROR = 0
REGISTRY_BIND = 0
REGISTRY_GLOBAL = 0
CALLBACK_DONE = 0
SHM_CREATE_POOL = 0
SHM_POOL_DESTROY = 1
SHM_INTERFACE = "wl_shm"
SHM_VERSION = 1
COMPOSITOR_CREATE_SURFACE = 0
COMPOSITOR_INTERFACE = "wl_compositor"
COMPOSITOR_VERSION = 4
SURFACE_DESTROY = 0
SURFACE_FRAME = 3
SURFACE_COMMIT = 6

# The ids this client gives its objects: the registry and its sync,
# then each check's from CHECK_FIRST_ID on.
REGISTRY_ID = 2
GLOBALS_SYNC_ID = 3
CHECK_FIRST_ID = 4

# A message's header: the object, then its size and opcode in one word.
HEADER = struct.Struct("<II")
WORD = 4
READ_SIZE = 4096

PASS = "WAYLAND-PROBE PASS"
FAIL = "WAYLAND-PROBE FAIL"


class Check(enum.Enum):
    """What a run checks, by the name it is given."""

    FDS = "fds"
    FRAMES = "frames"


def message(object_id, opcode, body=b""):
    """One request: the header, then the body's words."""
    size = HEADER.size + len(body)
    return HEADER.pack(object_id, (size << 16) | opcode) + body


def string(text):
    """A protocol string: its length with the NUL, then the bytes padded
    to a word."""
    raw = text.encode() + b"\0"
    padding = (-len(raw)) % WORD
    return struct.pack("<I", len(raw)) + raw + b"\0" * padding


class Connection:
    """The socket, the events read from it but not yet taken, and the
    registry's globals by interface."""

    def __init__(self, path):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(path)
        self.pending = b""
        self.globals = {}

    def send(self, data, fds=()):
        socket.send_fds(self.sock, [data], list(fds))

    def events(self):
        """Every event, as (object, opcode, body), until the connection
        ends."""
        while True:
            # Whole events from what has been read.
            while len(self.pending) >= HEADER.size:
                object_id, word = HEADER.unpack_from(self.pending)
                size, opcode = word >> 16, word & 0xFFFF
                if len(self.pending) < size:
                    break
                body = self.pending[HEADER.size : size]
                self.pending = self.pending[size:]
                yield object_id, opcode, body

            # More from the socket; nothing more, or a reset, is the
            # connection's end.
            try:
                data = self.sock.recv(READ_SIZE)
            except ConnectionResetError:
                return
            if not data:
                return
            self.pending += data

    def wait_for_done(self, callback_id, on_event=lambda *_: None):
        """Read events until `callback_id`'s done; False if the
        connection ends first. A protocol error ends the run."""
        for object_id, opcode, body in self.events():
            if object_id == DISPLAY_ID and opcode == DISPLAY_ERROR:
                raise SystemExit(f"{FAIL}: protocol error {body!r}")
            if object_id == callback_id and opcode == CALLBACK_DONE:
                return True
            on_event(object_id, opcode, body)
        return False

    def read_globals(self):
        """The registry's globals, from what the first sync brings."""

        def note(object_id, opcode, body):
            if object_id != REGISTRY_ID or opcode != REGISTRY_GLOBAL:
                return
            (name, length) = struct.unpack_from("<II", body)
            interface = body[2 * WORD : 2 * WORD + length - 1].decode()
            self.globals.setdefault(interface, name)

        self.send(
            message(DISPLAY_ID, DISPLAY_GET_REGISTRY, struct.pack("<I", REGISTRY_ID))
            + message(DISPLAY_ID, DISPLAY_SYNC, struct.pack("<I", GLOBALS_SYNC_ID))
        )
        if not self.wait_for_done(GLOBALS_SYNC_ID, note):
            raise SystemExit(f"{FAIL}: the connection ended before the globals")

    def bind(self, interface, version, new_id):
        """Bind a global the registry named."""
        if interface not in self.globals:
            raise SystemExit(f"{FAIL}: no {interface} global")
        self.send(
            message(
                REGISTRY_ID,
                REGISTRY_BIND,
                struct.pack("<I", self.globals[interface])
                + string(interface)
                + struct.pack("<II", version, new_id),
            )
        )


def check_fds(conn):
    """28 pools with their memfds in one write, then a sync that must be
    answered."""
    shm_id, sync_id, pool_first_id = CHECK_FIRST_ID, CHECK_FIRST_ID + 1, CHECK_FIRST_ID + 2
    conn.bind(SHM_INTERFACE, SHM_VERSION, shm_id)

    # The pools, each with a memfd of its own, and their destroys, in
    # one write.
    requests = b""
    fds = []
    for index in range(FDS_IN_ONE_WRITE):
        fd = os.memfd_create(f"pool-{index}")
        os.ftruncate(fd, POOL_SIZE)
        fds.append(fd)
        pool_id = pool_first_id + index
        requests += message(shm_id, SHM_CREATE_POOL, struct.pack("<Ii", pool_id, POOL_SIZE))
        requests += message(pool_id, SHM_POOL_DESTROY)
    conn.send(requests, fds)
    for fd in fds:
        os.close(fd)

    # The connection lives if the sync after them is answered.
    conn.send(message(DISPLAY_ID, DISPLAY_SYNC, struct.pack("<I", sync_id)))
    if not conn.wait_for_done(sync_id):
        return f"the connection ended after {FDS_IN_ONE_WRITE} pools in one write"
    print(f"{PASS}: {FDS_IN_ONE_WRITE} pools in one write, and the connection lives")
    return None


def check_frames(conn):
    """A frame callback of a surface with nothing on screen, committed:
    no done while the page draws, nor once the surface is gone."""
    compositor_id, surface_id, callback_id = CHECK_FIRST_ID, CHECK_FIRST_ID + 1, CHECK_FIRST_ID + 2
    next_sync_id = CHECK_FIRST_ID + 3
    conn.bind(COMPOSITOR_INTERFACE, COMPOSITOR_VERSION, compositor_id)

    # The surface, its callback, and the commit that latches it.
    conn.send(
        message(compositor_id, COMPOSITOR_CREATE_SURFACE, struct.pack("<I", surface_id))
        + message(surface_id, SURFACE_FRAME, struct.pack("<I", callback_id))
        + message(surface_id, SURFACE_COMMIT)
    )

    # Every event read is looked at for the callback's done.
    fired = []

    def note(object_id, opcode, _body):
        if object_id == callback_id and opcode == CALLBACK_DONE:
            fired.append(object_id)

    def roundtrip(requests=b""):
        nonlocal next_sync_id
        sync_id = next_sync_id
        next_sync_id += 1
        conn.send(requests + message(DISPLAY_ID, DISPLAY_SYNC, struct.pack("<I", sync_id)))
        return conn.wait_for_done(sync_id, note)

    # Roundtrips while the page draws its frames.
    deadline = time.monotonic() + HOLD_SECONDS
    while time.monotonic() < deadline:
        if not roundtrip():
            return "the connection ended"
        if fired:
            return "the frame callback of a surface with nothing on screen fired"
        time.sleep(HOLD_POLL_SECONDS)

    # Destroying the surface drops the callback.
    if not roundtrip(message(surface_id, SURFACE_DESTROY)):
        return "the connection ended"
    if fired:
        return "the frame callback fired as its surface was destroyed"
    print(f"{PASS}: no done in {HOLD_SECONDS} s for a surface with nothing on screen")
    return None


CHECKS = {
    Check.FDS: check_fds,
    Check.FRAMES: check_frames,
}


def main():
    check = Check(sys.argv[1])
    path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
        os.environ["XDG_RUNTIME_DIR"], os.environ["WAYLAND_DISPLAY"]
    )
    conn = Connection(path)
    conn.read_globals()

    # A check returns why it failed, or None.
    failure = CHECKS[check](conn)
    if failure is not None:
        print(f"{FAIL}: {failure}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
