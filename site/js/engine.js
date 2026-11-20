// Which engine a page load runs on, and which system that engine runs.
//
// The page has two engines. qemu emulates a whole x86_64 PC, kernel
// included, and resumes it from a snapshot. unkernel is a Linux kernel
// compiled to WebAssembly that emulates only the programs, which are
// aarch64. The kernel half of a first run (page faults, 9p reads, exec)
// costs unkernel almost nothing, and the kernel half is most of what a
// first run is, so unkernel is the default; docs/unkernel.md has the
// measurements.
//
// The two run different machine code, so the engine decides which of
// the multiverse's per-system indexes a package resolves against, and
// a store path only runs on the engine whose system the path was built
// for.

export const Engine = Object.freeze({
  UNKERNEL: "unkernel",
  QEMU: "qemu",
});

export const DEFAULT_ENGINE = Engine.UNKERNEL;

const SYSTEMS = Object.freeze({
  [Engine.UNKERNEL]: "aarch64-linux",
  [Engine.QEMU]: "x86_64-linux",
});

// The system an engine's guest runs: the name nixpkgs gives it and the
// multiverse files its data under.
export const systemOf = (engine) => SYSTEMS[engine];

// Whether a name, as a link might carry one, is an engine.
export const isEngine = (name) => Object.values(Engine).includes(name);

// The engine for one page load.
//
// `requested` is the link's engine parameter or null, `hasStorePath`
// says whether the link names a store path, and `jspi` says whether the
// browser can suspend WebAssembly, which unkernel's kernel needs to
// switch tasks.
//
// A link that names an engine gets the engine, even one the browser
// cannot run: the store paths in such a link were built for the named
// engine's system, so the other engine could only fail on them later
// and less legibly.
//
// A store path with no engine beside the path is a link from before
// there were two. Every one of those names an x86_64 path, so they run
// on qemu, and the page writes the engine into every link that carries
// a store path from here on (app.js, urlState).
export function chooseEngine({ requested, hasStorePath, jspi }) {
  if (isEngine(requested)) {
    return requested;
  }
  if (hasStorePath) {
    return Engine.QEMU;
  }
  return jspi ? DEFAULT_ENGINE : Engine.QEMU;
}

// Whether the browser has JavaScript Promise Integration, the one
// feature unkernel requires that qemu does not.
export const hasJspi = () =>
  typeof WebAssembly === "object" &&
  typeof WebAssembly.Suspending === "function" &&
  typeof WebAssembly.promising === "function";

// The ELF header fields read below: the magic, and e_machine as a
// little-endian u16 at offset 18.
const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46];
const ELF_MACHINE_OFFSET = 18;
const ELF_MACHINE_END = ELF_MACHINE_OFFSET + 2;
const BITS_PER_BYTE = 8;

const ELF_SYSTEMS = new Map([
  [62, "x86_64-linux"],
  [183, "aarch64-linux"],
]);

// The system an ELF file was built for, or null when the bytes are not
// ELF or name a machine neither engine runs.
export function elfSystem(bytes) {
  if (bytes.byteLength < ELF_MACHINE_END) {
    return null;
  }
  if (!ELF_MAGIC.every((byte, at) => bytes[at] === byte)) {
    return null;
  }

  const machine =
    bytes[ELF_MACHINE_OFFSET] |
    (bytes[ELF_MACHINE_OFFSET + 1] << BITS_PER_BYTE);
  return ELF_SYSTEMS.get(machine) ?? null;
}

const PROGRAM_PREFIX = "bin/";

// The system a parsed NAR's programs were built for when that system
// is not `system`, or null when nothing in bin/ disagrees.
//
// A store path pasted into the page is whatever the reader pasted, and
// nothing in a narinfo says which machine the path was built for. The
// guest's own answer to a foreign binary is "Exec format error", or
// "not found" when the kernel cannot find the other machine's loader,
// and neither tells a reader that switching engines is the fix. Scripts
// and data files are skipped: they carry no machine.
export function foreignSystem(entries, system) {
  for (const entry of entries) {
    if (
      entry.type !== "regular" ||
      !entry.executable ||
      !entry.path.startsWith(PROGRAM_PREFIX)
    ) {
      continue;
    }

    const built = elfSystem(entry.data);
    if (built !== null && built !== system) {
      return built;
    }
  }
  return null;
}

// The engine that runs `system`, or null when neither does.
export function engineFor(system) {
  const found = Object.entries(SYSTEMS).find(([, name]) => name === system);
  return found === undefined ? null : found[0];
}
