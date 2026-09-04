# trynix

Boot anything nixpkgs ever shipped, in your browser.

trynix glues three existing pieces into one static site: the
[nixpkgs-multiverse] index resolves any `(attribute, version)` in
nixpkgs history to the store path Hydra built, cache.nixos.org serves
that closure to the browser directly (the cache allows CORS), and
[qemu-wasm] boots an x86_64 Linux guest in the tab that mounts the
fetched store over virtio-9p and drops into a shell. [grail]'s solver
extends "one package" to "a coexistent set": boot python 3.10 next to
openssl 1.1 at the one moment in history they agreed.

No server anywhere. See [docs/design.md](./docs/design.md) for the
architecture, what the qemu-wasm survey established, and the milestones.

## Status

Scaffold. The first slice works: paste a store path and the site walks
its runtime closure live from cache.nixos.org and prices the download —
the exact set of NARs a boot will fetch. The NAR unpack, the guest
image, and the qemu-wasm boot are next; the plan is in the design doc.

## Running

```console
$ nix run .#serve         # build the site and serve it on :8137
$ nix flake check         # tests + the site assembles
$ nix fmt                 # before committing
```

## Credits

- [qemu-wasm] by ktock: QEMU on emscripten, the wasm TCG JIT, and the
  virtio-9p port that makes the store-into-guest path possible.
- [tomberek]'s fastpkgs fake-derivation trick underlies the multiverse
  fast path trynix resolves against.
- [ghostty-web] (libghostty-vt compiled to wasm, xterm.js-compatible) is
  the intended terminal.

## License

MIT, please see [LICENSE](LICENSE).

[nixpkgs-multiverse]: https://github.com/fzakaria/nixpkgs-multiverse
[grail]: https://github.com/fzakaria/grail
[qemu-wasm]: https://github.com/ktock/qemu-wasm
[ghostty-web]: https://github.com/coder/ghostty-web
[tomberek]: https://github.com/tomberek
