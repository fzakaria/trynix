"""Tests kwvk's SPIR-V passes (patches/kwvk/0002, 0003 and 0005), which
the driver runs on every module before it reaches the page: storage
buffers a shader never writes must come out NonWritable and the
written ones must stay writable, descriptor bindings no function uses
must be gone, no OpLine or OpNoLine may be left, and the module must
still validate.

Each case compiles a shader from shaders/ with glslang, runs the
harness (harness.c, built against the patched icd.c) on it, and checks
what the harness prints and spirv-val and spirv-dis say of its output.

    python3 spirv-test.py <harness binary> <shaders dir> <work dir>
"""

import enum
import os
import subprocess
import sys


class Env(enum.Enum):
    """The SPIR-V environment a case is compiled and validated for. From
    SPIR-V 1.4 on, an entry point's interface lists every global it
    uses, its descriptor bindings among them, so dropping a binding has
    to take it out of the interface too."""

    VULKAN_1_2 = "vulkan1.2"
    VULKAN_1_4 = "vulkan1.4"


class Debug(enum.Enum):
    """Whether glslang writes source lines into the module (-g), as
    Taisei's run-time compiles do."""

    OFF = ()
    LINES = ("-g",)


# Per case: the shader, its environment, glslang's debug info, the
# writable storage bindings ("set.binding") after the passes, and the
# bindings left declared.
CASES = {
    "bones": ("bones.vert", Env.VULKAN_1_2, Debug.OFF, [], ["1.3", "1.4"]),
    "bones-lines": ("bones.vert", Env.VULKAN_1_2, Debug.LINES, [], ["1.3", "1.4"]),
    "writes": ("writes.frag", Env.VULKAN_1_2, Debug.OFF, ["0.0"], ["0.0", "0.1"]),
    "atomic": ("atomic.comp", Env.VULKAN_1_2, Debug.OFF, ["0.0"], ["0.0", "0.1"]),
    "param": ("param.comp", Env.VULKAN_1_2, Debug.OFF, ["0.0"], ["0.0"]),
    "unused": ("unused.frag", Env.VULKAN_1_2, Debug.OFF, [], ["1.3", "2.0", "2.1"]),
    "unused-1.4": ("unused.frag", Env.VULKAN_1_4, Debug.OFF, [], ["1.3", "2.0", "2.1"]),
}

# The debug line instructions the passes drop, as spirv-dis prints them.
LINE_OPS = ("OpLine", "OpNoLine")


def field(output, label):
    """The values on the harness's line that starts with `label`."""
    line = next(line for line in output.splitlines() if line.startswith(label))
    return line.split()[1:]


def run_case(harness, shaders, work, name, case):
    """Compile, pass and validate one case; returns a failure or None."""
    shader, env, debug, writable, bindings = case
    module = os.path.join(work, f"{name}.spv")
    passed = os.path.join(work, f"{name}.out.spv")

    # The module, as glslang compiles it for the program.
    subprocess.run(
        ["glslang", "-V", "--target-env", env.value, *debug.value, "-o", module, os.path.join(shaders, shader)],
        check=True,
        capture_output=True,
    )

    # The passes, and the module they give.
    run = subprocess.run([harness, module, passed], capture_output=True, text=True)
    if run.returncode != 0:
        return f"the harness exited {run.returncode}: {run.stderr.strip()}"
    after = field(run.stdout, "after:")
    declared = field(run.stdout, "bindings:")

    # What the page would get: valid, and without line instructions.
    valid = subprocess.run(["spirv-val", "--target-env", env.value, passed], capture_output=True, text=True)
    text = subprocess.run(["spirv-dis", passed], capture_output=True, text=True, check=True).stdout
    lines_left = sum(text.count(f"{op} ") for op in LINE_OPS)

    if sorted(after) != sorted(writable):
        return f"writable after the passes: {after}, want {writable}"
    if sorted(declared) != sorted(bindings):
        return f"bindings after the passes: {declared}, want {bindings}"
    if valid.returncode != 0:
        return f"spirv-val: {valid.stderr.strip()}"
    if lines_left != 0:
        return f"{lines_left} line instructions left"
    return None


def main():
    harness, shaders, work = sys.argv[1:4]
    failed = 0
    for name, case in CASES.items():
        failure = run_case(harness, shaders, work, name, case)
        if failure is None:
            print(f"ok {name}")
            continue
        failed += 1
        print(f"FAIL {name}: {failure}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
