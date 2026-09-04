// A parser for the Nix ARchive format. A NAR is a deterministic
// serialisation of one store path: length-prefixed strings (64-bit
// little-endian length, contents padded to 8 bytes) forming a bracketed
// tree of regular files, symlinks and directories.
//
// parseNar walks the archive and returns a flat entry list in archive
// order — directories before their children — with slash-joined paths
// relative to the root ("" is the root itself). File contents are
// subarray views into the input buffer, not copies.

const PAD = 8;
const MAGIC = "nix-archive-1";

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = 0;
    this.decoder = new TextDecoder();
  }

  u64() {
    // NAR lengths fit in a JS number long before a browser tab does.
    const lo = this.view.getUint32(this.offset, true);
    const hi = this.view.getUint32(this.offset + 4, true);
    this.offset += 8;
    return hi * 2 ** 32 + lo;
  }

  // A length-prefixed byte string, padded to the 8-byte boundary.
  blob() {
    const length = this.u64();
    const data = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length + ((PAD - (length % PAD)) % PAD);
    return data;
  }

  token() {
    return this.decoder.decode(this.blob());
  }

  expect(want) {
    const got = this.token();
    if (got !== want) {
      throw new Error(
        `bad NAR: expected "${want}", got "${got}" at ${this.offset}`,
      );
    }
  }
}

function parseNode(reader, path, entries) {
  reader.expect("(");
  reader.expect("type");
  const type = reader.token();

  if (type === "regular") {
    let token = reader.token();
    let executable = false;
    if (token === "executable") {
      executable = true;
      reader.expect("");
      token = reader.token();
    }
    if (token !== "contents") {
      throw new Error(`bad NAR: expected "contents", got "${token}"`);
    }
    entries.push({ path, type, executable, data: reader.blob() });
    reader.expect(")");
    return;
  }

  if (type === "symlink") {
    reader.expect("target");
    entries.push({ path, type, target: reader.token() });
    reader.expect(")");
    return;
  }

  if (type === "directory") {
    entries.push({ path, type });
    for (let token = reader.token(); token !== ")"; token = reader.token()) {
      if (token !== "entry") {
        throw new Error(`bad NAR: expected "entry", got "${token}"`);
      }
      reader.expect("(");
      reader.expect("name");
      const name = reader.token();
      reader.expect("node");
      parseNode(reader, path === "" ? name : `${path}/${name}`, entries);
      reader.expect(")");
    }
    return;
  }

  throw new Error(`bad NAR: unknown node type "${type}"`);
}

export function parseNar(bytes) {
  const reader = new Reader(bytes);
  reader.expect(MAGIC);
  const entries = [];
  parseNode(reader, "", entries);
  return entries;
}
