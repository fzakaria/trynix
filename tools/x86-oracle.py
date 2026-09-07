#!/usr/bin/env python3
"""Harvest an instruction oracle for the x86 decoder from objdump.

The decoder in site/js/x86/decode.js is checked against binutils rather
than against a hand-written expectation: every instruction objdump finds
in a real store binary is written out as its bytes and its Intel-syntax
mnemonic, and the test requires the decoder to agree on both the length
and the mnemonic of each. The fixture is deduplicated by encoding and
capped per (mnemonic, length) so it stays small while still covering
every opcode and operand form the binaries use.

    nix run .#x86-oracle -- <out file> <binary>...

VEX and EVEX encodings (the AVX variants glibc selects by ifunc) are
harvested too, with the mnemonic prefixed by "v" as objdump prints it;
the test treats them as length-only until the translator learns them.
"""

import re
import subprocess
import sys

# How many distinct encodings of one (mnemonic, length) pair to keep.
# Enough to cover the register and addressing-mode forms, few enough
# that a big binary does not swamp the fixture with `mov`.
PER_FORM_CAP = 24

# objdump prints these before the mnemonic; they are part of the
# encoding, so they stay in the bytes but not in the mnemonic column.
PREFIX_WORDS = {
    "rep", "repz", "repnz", "repe", "repne", "lock", "cs", "ds", "es", "fs",
    "gs", "ss", "data16", "data32", "addr32", "bnd", "notrack", "rex",
    "rex.W", "rex.B", "rex.R", "rex.X", "rex.WB", "rex.WR", "rex.WX",
    "rex.RB", "rex.WRB", "rex.WRX", "rex.WXB", "rex.RXB", "rex.WRXB",
    "rex.RX", "rex.XB", "{evex}", "{vex}", "{vex3}", "{disp32}", "{disp8}",
}

LINE = re.compile(r"^\s*[0-9a-f]+:\t((?:[0-9a-f]{2} )+)\s*\t?(.*)$")


def mnemonic_of(text):
    words = text.split()
    while words and words[0] in PREFIX_WORDS:
        words.pop(0)
    if not words:
        # A line of nothing but prefixes: objdump split a long nop's
        # prefixes onto their own line. Skip it.
        return None
    return words[0]


def harvest(binary, seen, out):
    proc = subprocess.run(
        ["objdump", "-d", "-w", "-M", "intel", binary],
        capture_output=True,
        text=True,
        check=True,
    )
    for line in proc.stdout.splitlines():
        m = LINE.match(line)
        if not m:
            continue
        raw = m.group(1).split()
        text = m.group(2).strip()
        if text.startswith("(bad)") or text == "":
            continue
        mnem = mnemonic_of(text)
        if mnem is None:
            continue
        enc = "".join(raw)
        key = (mnem, len(raw))
        if enc in seen["encodings"]:
            continue
        if seen["forms"].get(key, 0) >= PER_FORM_CAP:
            continue
        seen["encodings"].add(enc)
        seen["forms"][key] = seen["forms"].get(key, 0) + 1
        text = re.sub(r"\s*<[^>]*>", "", text)
        text = re.sub(r"\s+", " ", text)
        out.append(f"{enc} {mnem} {text}")


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    out_path, binaries = sys.argv[1], sys.argv[2:]
    seen = {"encodings": set(), "forms": {}}
    lines = []
    for b in binaries:
        harvest(b, seen, lines)
    with open(out_path, "w") as f:
        f.write("# bytes mnemonic objdump-text, harvested by tools/x86-oracle.py\n")
        f.write("\n".join(lines) + "\n")
    print(f"{len(lines)} instructions, {len(seen['forms'])} forms")


if __name__ == "__main__":
    main()
