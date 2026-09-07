// A filesystem backend over node's own: the guest sees the host's
// files, which makes every path in /nix/store a test case. The page
// uses a different backend over the NAR-unpacked tree; the interface
// is what linux.js calls.
//
// Interface:
//   stat(path, followLinks) -> { mode, size, ino, nlink, uid, gid, mtime, blksize, blocks }
//   open(path, flags, mode) -> file { read(buf, pos), write(buf, pos), size(), close(), readdir?() }
//   readlink(path) -> string
//   mkdir, unlink, rmdir, rename, symlink, access, chmod, utimes as needed
// Errors are thrown as Errno.
import fs from "node:fs";

import { E, Errno } from "./errno.js";

const NODE_ERRNO = {
  ENOENT: E.NOENT,
  EACCES: E.ACCES,
  EPERM: E.PERM,
  EEXIST: E.EXIST,
  ENOTDIR: E.NOTDIR,
  EISDIR: E.ISDIR,
  EINVAL: E.INVAL,
  EBADF: E.BADF,
  ENOTEMPTY: E.NOTEMPTY,
  ELOOP: E.LOOP,
  ENAMETOOLONG: E.NAMETOOLONG,
  EROFS: E.ROFS,
  EMFILE: E.MFILE,
  ENOSPC: E.NOSPC,
  EPIPE: E.PIPE,
  EAGAIN: E.AGAIN,
  ENOTTY: E.NOTTY,
};

function wrap(fn) {
  try {
    return fn();
  } catch (e) {
    if (e && e.code && NODE_ERRNO[e.code] !== undefined) {
      throw new Errno(NODE_ERRNO[e.code], e.path || "");
    }
    throw e;
  }
}

function statOf(st) {
  return {
    mode: st.mode,
    size: st.size,
    ino: Number(st.ino),
    nlink: st.nlink,
    uid: st.uid,
    gid: st.gid,
    dev: Number(st.dev),
    rdev: Number(st.rdev),
    blksize: st.blksize,
    blocks: st.blocks,
    atime: st.atimeMs / 1000,
    mtime: st.mtimeMs / 1000,
    ctime: st.ctimeMs / 1000,
  };
}

class NodeFile {
  constructor(fd, path, flags) {
    this.fd = fd;
    this.path = path;
    this.flags = flags;
  }

  read(buf, pos) {
    return wrap(() => fs.readSync(this.fd, buf, 0, buf.length, pos));
  }

  write(buf, pos) {
    return wrap(() => fs.writeSync(this.fd, buf, 0, buf.length, pos));
  }

  stat() {
    return statOf(wrap(() => fs.fstatSync(this.fd)));
  }

  readdir() {
    return wrap(() => fs.readdirSync(this.path, { withFileTypes: true })).map((d) => ({
      name: d.name,
      type: d.isDirectory() ? 4 : d.isSymbolicLink() ? 10 : d.isFile() ? 8 : 0,
      ino: 0,
    }));
  }

  close() {
    wrap(() => fs.closeSync(this.fd));
  }
}

export class NodeFs {
  stat(path, followLinks = true) {
    return statOf(wrap(() => (followLinks ? fs.statSync(path) : fs.lstatSync(path))));
  }

  // flags are Linux O_* bits; node's constants match on Linux.
  open(path, flags, mode = 0o666) {
    const fd = wrap(() => fs.openSync(path, flags, mode));
    return new NodeFile(fd, path, flags);
  }

  readlink(path) {
    return wrap(() => fs.readlinkSync(path));
  }

  access(path, mode) {
    wrap(() => fs.accessSync(path, mode));
  }

  mkdir(path, mode) {
    wrap(() => fs.mkdirSync(path, { mode }));
  }

  unlink(path) {
    wrap(() => fs.unlinkSync(path));
  }

  rmdir(path) {
    wrap(() => fs.rmdirSync(path));
  }

  rename(from, to) {
    wrap(() => fs.renameSync(from, to));
  }

  symlink(target, path) {
    wrap(() => fs.symlinkSync(target, path));
  }

  chmod(path, mode) {
    wrap(() => fs.chmodSync(path, mode));
  }

  truncate(path, len) {
    wrap(() => fs.truncateSync(path, len));
  }
}
