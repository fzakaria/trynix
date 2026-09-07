// An in-memory filesystem for the page: the store paths of a closure,
// as the NAR entries site/js/nar.js parses, plus a writable tmpfs for
// everything a program creates. The same interface fs-node.js offers
// over the host's files, so the kernel does not know which it has.
//
// File contents are the views into the decompressed archives that the
// NAR parser produced, never copied: the closure lives in the tab
// exactly once.
import { E, Errno } from "./errno.js";

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

const O_ACCMODE = 3;
const O_WRONLY = 1;
const O_RDWR = 2;
const O_CREAT = 0o100;
const O_EXCL = 0o200;
const O_TRUNC = 0o1000;
const O_APPEND = 0o2000;

// How many symlinks one lookup may follow.
const MAX_LINKS = 40;

let nextIno = 1;

class Node {
  constructor(type, mode) {
    this.type = type; // "dir" | "file" | "link"
    this.mode = mode;
    this.ino = nextIno++;
    this.mtime = Date.now() / 1000;
    this.children = type === "dir" ? new Map() : null;
    this.data = type === "file" ? new Uint8Array(0) : null;
    this.target = type === "link" ? "" : null;
    // A file from a NAR keeps the archive's view; a written file owns
    // a growable buffer.
    this.owned = false;
  }

  stat() {
    const size =
      this.type === "file"
        ? this.data.length
        : this.type === "link"
          ? this.target.length
          : 4096;
    return {
      mode: this.mode,
      size,
      ino: this.ino,
      nlink: 1,
      uid: 1000,
      gid: 100,
      dev: 1,
      rdev: 0,
      blksize: 4096,
      blocks: Math.ceil(size / 512),
      atime: this.mtime,
      mtime: this.mtime,
      ctime: this.mtime,
    };
  }
}

class MemoryFile {
  constructor(node, path, flags) {
    this.node = node;
    this.path = path;
    this.flags = flags;
  }

  read(buf, pos) {
    const data = this.node.data;
    if (pos >= data.length) {
      return 0;
    }
    const n = Math.min(buf.length, data.length - pos);
    buf.set(data.subarray(pos, pos + n));
    return n;
  }

  write(buf, pos) {
    const node = this.node;
    const end = pos + buf.length;
    if (!node.owned || end > node.data.length) {
      const grown = new Uint8Array(
        Math.max(end, node.owned ? node.data.length * 2 : end),
      );
      grown.set(
        node.data.subarray(
          0,
          Math.min(node.data.length, node.capacity ?? node.data.length),
        ),
      );
      // Keep the logical length separate from the buffer's.
      const length = node.owned ? node.length : node.data.length;
      node.data = grown.subarray(0, Math.max(length, end));
      node.buffer = grown;
      node.owned = true;
    }
    if (end > node.data.length) {
      node.data = node.buffer.subarray(0, end);
    }
    node.data.set(buf, pos);
    node.length = node.data.length;
    node.mtime = Date.now() / 1000;
    return buf.length;
  }

  stat() {
    return this.node.stat();
  }

  readdir() {
    return [...this.node.children].map(([name, child]) => ({
      name,
      type: child.type === "dir" ? 4 : child.type === "link" ? 10 : 8,
      ino: child.ino,
    }));
  }

  close() {}
}

export class MemoryFs {
  constructor() {
    this.root = new Node("dir", S_IFDIR | 0o755);
    for (const dir of [
      "/nix/store",
      "/tmp",
      "/home/user",
      "/dev",
      "/proc",
      "/etc",
    ]) {
      this.mkdirp(dir);
    }
  }

  mkdirp(path) {
    let node = this.root;
    for (const part of path.split("/").filter(Boolean)) {
      let child = node.children.get(part);
      if (child === undefined) {
        child = new Node("dir", S_IFDIR | 0o755);
        node.children.set(part, child);
      }
      node = child;
    }
    return node;
  }

  // Adds one store path from its NAR entries. Entries arrive
  // directories first, as the archive lists them.
  addStorePath(storePath, entries) {
    const rootParts = storePath.split("/").filter(Boolean);
    for (const entry of entries) {
      const parts =
        entry.path === ""
          ? rootParts
          : [...rootParts, ...entry.path.split("/")];
      const name = parts[parts.length - 1];
      const parent = this.mkdirp(parts.slice(0, -1).join("/"));
      let node;
      if (entry.type === "directory") {
        node = parent.children.get(name);
        if (node === undefined) {
          node = new Node("dir", S_IFDIR | 0o555);
        }
      } else if (entry.type === "regular") {
        node = new Node("file", S_IFREG | (entry.executable ? 0o555 : 0o444));
        node.data = entry.data;
      } else {
        node = new Node("link", S_IFLNK | 0o777);
        node.target = entry.target;
      }
      parent.children.set(name, node);
    }
  }

  // Writes a small file the page prepares, such as /etc/passwd.
  writeFile(path, text) {
    const parts = path.split("/").filter(Boolean);
    const parent = this.mkdirp(parts.slice(0, -1).join("/"));
    const node = new Node("file", S_IFREG | 0o644);
    node.data =
      typeof text === "string" ? new TextEncoder().encode(text) : text;
    node.owned = false;
    parent.children.set(parts[parts.length - 1], node);
  }

  // Resolves a path to its node, following symlinks (except the last
  // component when followLast is false). Returns { node, parent, name }
  // with node null when the last component does not exist.
  resolve(path, followLast = true, depth = 0) {
    if (depth > MAX_LINKS) {
      throw new Errno(E.LOOP, path);
    }
    const parts = path.split("/").filter((p) => p !== "" && p !== ".");
    let node = this.root;
    let parent = this.root;
    let name = "";
    const walked = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === "..") {
        walked.pop();
        node = this.resolve(`/${walked.join("/")}`, true, depth + 1).node;
        parent = node;
        continue;
      }
      if (node === null || node.type !== "dir") {
        throw new Errno(E.NOTDIR, path);
      }
      parent = node;
      name = part;
      const child = node.children.get(part);
      const last = i === parts.length - 1;
      if (child === undefined) {
        if (!last) {
          throw new Errno(E.NOENT, path);
        }
        return { node: null, parent, name };
      }
      if (child.type === "link" && (!last || followLast)) {
        const target = child.target.startsWith("/")
          ? child.target
          : `/${[...walked, child.target].join("/")}`;
        const rest = parts.slice(i + 1).join("/");
        return this.resolve(
          rest === "" ? target : `${target}/${rest}`,
          followLast,
          depth + 1,
        );
      }
      walked.push(part);
      node = child;
    }
    return { node, parent, name };
  }

  lookup(path, followLast = true) {
    const { node } = this.resolve(path, followLast);
    if (node === null) {
      throw new Errno(E.NOENT, path);
    }
    return node;
  }

  stat(path, followLinks = true) {
    return this.lookup(path, followLinks).stat();
  }

  open(path, flags, mode = 0o666) {
    const { node, parent, name } = this.resolve(path, true);
    const wants = flags & O_ACCMODE;
    if (node === null) {
      if (!(flags & O_CREAT)) {
        throw new Errno(E.NOENT, path);
      }
      const created = new Node("file", S_IFREG | (mode & 0o777));
      created.owned = true;
      created.length = 0;
      created.buffer = new Uint8Array(0);
      parent.children.set(name, created);
      return new MemoryFile(created, path, flags);
    }
    if (flags & O_CREAT && flags & O_EXCL) {
      throw new Errno(E.EXIST, path);
    }
    if (node.type === "dir") {
      if (wants !== 0) {
        throw new Errno(E.ISDIR, path);
      }
      return new MemoryFile(node, path, flags);
    }
    if (wants !== 0 && (node.mode & 0o222) === 0) {
      throw new Errno(E.ACCES, path);
    }
    if (flags & O_TRUNC && wants !== 0) {
      node.data = new Uint8Array(0);
      node.buffer = node.data;
      node.owned = true;
      node.length = 0;
    }
    return new MemoryFile(node, path, flags);
  }

  readlink(path) {
    const node = this.lookup(path, false);
    if (node.type !== "link") {
      throw new Errno(E.INVAL, path);
    }
    return node.target;
  }

  access(path, mode) {
    const node = this.lookup(path, true);
    if (mode & 2 && (node.mode & 0o222) === 0) {
      throw new Errno(E.ACCES, path);
    }
  }

  mkdir(path, mode) {
    const { node, parent, name } = this.resolve(path, true);
    if (node !== null) {
      throw new Errno(E.EXIST, path);
    }
    parent.children.set(name, new Node("dir", S_IFDIR | (mode & 0o777)));
  }

  unlink(path) {
    const { node, parent, name } = this.resolve(path, false);
    if (node === null) {
      throw new Errno(E.NOENT, path);
    }
    if (node.type === "dir") {
      throw new Errno(E.ISDIR, path);
    }
    parent.children.delete(name);
  }

  rmdir(path) {
    const { node, parent, name } = this.resolve(path, false);
    if (node === null) {
      throw new Errno(E.NOENT, path);
    }
    if (node.type !== "dir") {
      throw new Errno(E.NOTDIR, path);
    }
    if (node.children.size > 0) {
      throw new Errno(E.NOTEMPTY, path);
    }
    parent.children.delete(name);
  }

  rename(from, to) {
    const src = this.resolve(from, false);
    if (src.node === null) {
      throw new Errno(E.NOENT, from);
    }
    const dst = this.resolve(to, false);
    dst.parent.children.set(dst.name, src.node);
    src.parent.children.delete(src.name);
  }

  symlink(target, path) {
    const { node, parent, name } = this.resolve(path, false);
    if (node !== null) {
      throw new Errno(E.EXIST, path);
    }
    const link = new Node("link", S_IFLNK | 0o777);
    link.target = target;
    parent.children.set(name, link);
  }

  chmod(path, mode) {
    const node = this.lookup(path, true);
    node.mode = (node.mode & ~0o7777) | (mode & 0o7777);
  }

  truncate(path, len) {
    const node = this.lookup(path, true);
    if (node.type !== "file") {
      throw new Errno(E.ISDIR, path);
    }
    const grown = new Uint8Array(len);
    grown.set(node.data.subarray(0, Math.min(len, node.data.length)));
    node.data = grown;
    node.buffer = grown;
    node.owned = true;
    node.length = len;
  }
}
