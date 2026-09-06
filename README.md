# trynix

Boot anything nixpkgs ever shipped, in your browser: https://trynix.dev

Pick a package and a version from 13 years of nixpkgs history. Its
closure is fetched from cache.nixos.org into an x86_64 Linux virtual
machine running in the tab, and you get a shell with the package on
PATH. Nothing runs on a server.

trynix is glue between existing pieces. The [nixpkgs-multiverse]
index resolves any `(attribute, version)` in nixpkgs history to the
store path Hydra built; cache.nixos.org serves that closure to the
browser directly, since the cache allows cross-origin reads; and
[qemu-wasm] boots an x86_64 guest in the tab that mounts the fetched
store over virtio-9p. [grail]'s solver extends "one package" to "a set
that coexisted": python 3.10 next to openssl 1.1, at the one moment in
history they agreed.

## Life of a Boot

1. The selection resolves to store-path digests from the multiverse
   index, or from a store path pasted in.
2. The runtime closure is walked from narinfos on cache.nixos.org, and
   every signature is checked against the configured keys.
3. The engine, QEMU compiled to WebAssembly, is instantiated while the
   NARs download. Each NAR is decompressed (xz or zstd) and written
   into the in-memory filesystem the VM's 9p share reads from, the
   moment it arrives.
4. The VM does not boot. It resumes from a migration snapshot taken on
   a native build of the same QEMU: a guest already up and parked,
   waiting for the share. One newline finishes the handshake, the guest
   mounts the store, and the shell is live.
5. The programs of every store path are offered through one directory
   of symlinks the guest keeps on PATH, so adding a package to a
   running VM adds links and types nothing at the shell.

Steps 2 and 3 overlap, which is most of why the warm path fits in three
seconds. Measured in headless Chromium on a warm cache:

```mermaid
gantt
    title Page open to shell prompt, warm cache
    dateFormat x
    axisFormat %S.%Ls
    tickInterval 500millisecond
    section Page
    walk the closure (cached narinfos) :done, 0, 100
    fetch and unpack the NARs          :done, 100, 1000
    section Engine
    instantiate qemu-wasm              :active, 0, 1000
    load the migration stream          :active, 1000, 2500
    section Guest
    mount the share, exec a shell      :2500, 3100
```

The URL is the state: packages, store paths, extra binary caches with
their keys, all in the query string, so an environment is a link to
send ([design.md, "The link"](docs/design.md#the-link)).

Everything large — the engine, the guest image, the snapshot, every
NAR and narinfo — is kept in the browser's cache, so a second boot of
a package costs no download. On a warm cache a shell is up in about
three seconds; [design.md](docs/design.md#start-time) has the numbers
and where the time goes.

## Layout

`site/` is the static site: vanilla ES modules, on the multiverse
chrome and tokens so the family of sites reads as one. `nix/` holds the
flake's pieces: `site.nix` assembles the deployable tree, `guest.nix`
builds the guest image (a trimmed Linux kernel and a busybox
initramfs), `engine.nix` fetches the pinned engine, `vendor.nix` pins
the browser dependencies, and `formatter.nix` is `nix fmt`.
[`nix/guest/machine.json`](nix/guest/machine.json) is the one
description of the virtual machine, read by the page and by the
snapshot tool.

`patches/` carries the changes to qemu-wasm the engine is built with.
`tools/` holds the engine tools, each a flake app (`nix run .#<name>`).
`tests/` is the node test suite, which runs offline.

The docs are [design.md](docs/design.md) for the architecture and what
was measured, [engine.md](docs/engine.md) for building and publishing
the engine and the snapshot, and [performance.md](docs/performance.md)
for where a first run's time goes and which optimisations were dead
ends.

## Running

```console
$ nix run .#serve         # build the site and serve it on :8137
$ nix flake check         # tests, the site assembles, snapshot pins match
$ nix run .#boot-test     # open the site in a browser, wait for a shell
$ nix fmt                 # before committing
```

The site is deployed by GitHub Actions from `nix build .#site`, which
produces the whole tree including the engine and the snapshot, fetched
by hash from a dated release ([engine.md](docs/engine.md)).

## Credits

- [qemu-wasm] by ktock: QEMU on emscripten, the wasm TCG JIT, and the
  virtio-9p port that makes the store-into-guest path possible.
- [tomberek]'s fastpkgs fake-derivation trick underlies the multiverse
  fast path trynix resolves against.
- [ghostty-web]: libghostty-vt compiled to wasm, the terminal.

## License

MIT, please see [LICENSE](LICENSE).

[nixpkgs-multiverse]: https://github.com/fzakaria/nixpkgs-multiverse
[grail]: https://github.com/fzakaria/grail
[qemu-wasm]: https://github.com/ktock/qemu-wasm
[ghostty-web]: https://github.com/coder/ghostty-web
[tomberek]: https://github.com/tomberek
