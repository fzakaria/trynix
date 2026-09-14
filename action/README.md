# trynix preview action

[![on the GitHub Marketplace](https://img.shields.io/badge/marketplace-trynix%20preview-blue?logo=github)](https://github.com/marketplace/actions/trynix-preview)

Comment a link on a pull request that boots what it built, in the
reviewer's browser.

The action names the store paths a flake attribute produces and posts a
[trynix.dev](https://trynix.dev) link that mounts them in an x86_64 VM
running in the tab. A reviewer clicks it and gets a shell with the
branch's build on PATH. There is no server and nothing to install.

Publishing is your workflow's job, not this action's. Whatever already
fills your cache keeps doing it, and this takes the cache's URL and
public key and hands them to the browser. A cache is a URL and a key
here, never a provider, so cachix, attic, a `nix copy` to an S3 bucket
and a directory of narinfos on a static host are all the same thing to
it. It holds no token of its own.

## What the comment gets you

[This link boots a `hello` that exists in one cachix cache and nowhere
else](https://trynix.dev/?path=/nix/store/7p6lkap7nrhd06ph3ldv414zarrj52xy-hello-trynix-static-x86_64-unknown-linux-musl-2.12.2&cache=https://trynix.cachix.org+trynix.cachix.org-1:xmOWOHz2g/BlpCVQrTEZjSKWPk3S3Dukn1xiSWLidkY%3D). Press Boot, wait about three seconds, and type `hello`:

```
~ # hello
Hello from trynix.cachix.org, fetched into your browser!
```

It is a patched, statically linked `hello` pushed to
`trynix.cachix.org`. Static and renamed deliberately: the closure is one
path and `cache.nixos.org` answers 404 for it, so every byte in that VM
came from the cachix cache named in the link. That is the thing a
preview comment hands a reviewer.

## Examples

Build, publish, link. The order of the last three steps is the whole
pattern:

```yaml
- uses: cachix/cachix-action@v15
  with:
    name: my-cache
    authToken: ${{ secrets.CACHIX_AUTH_TOKEN }}
- run: nix build .#my-package
- uses: fzakaria/trynix@v1
  with:
    cache: https://my-cache.cachix.org
    publicKey: my-cache.cachix.org-1:0Ma9…
    attrs: .#my-package
```

A public cachix cache publishes its key, so you can look yours up rather
than dig it out of a settings page:

```console
$ curl -sS https://app.cachix.org/api/v1/cache/my-cache | jq -r '.publicSigningKeys[]'
my-cache.cachix.org-1:0Ma9…
```

Anywhere else the same two values, pointed somewhere else:

```yaml
- uses: fzakaria/trynix@v1
  with:
    cache: https://cache.example.org
    publicKey: cache.example.org-1:5Kq2…
    attrs: .#my-package
```

Several attributes boot together in one VM, which is what you want for a
server and the client that talks to it:

```yaml
- uses: fzakaria/trynix@v1
  with:
    cache: https://my-cache.cachix.org
    publicKey: my-cache.cachix.org-1:0Ma9…
    attrs: |
      .#server
      .#apps.x86_64-linux.cli
```

Complete workflows are in [examples/](examples/), including the two that
cover pull requests from forks. Put `cachix/install-nix-action` ahead of
this action and give the job `pull-requests: write`.

## Options

### Cache

| Input       | Description                                                                 | Required | Default |
| ----------- | --------------------------------------------------------------------------- | -------- | ------- |
| `cache`     | The cache the browser fetches from, as a full URL                           | ✓        |         |
| `publicKey` | The key it signs with, `name:base64`. One per line for a cache mid-rotation | ✓        |         |

### What to name

| Input    | Description                                                                                               | Required | Default     |
| -------- | --------------------------------------------------------------------------------------------------------- | -------- | ----------- |
| `attrs`  | Flake attributes, one per line. A package or an app                                                       |          | `.#default` |
| `build`  | Build the attributes rather than only evaluating them. Turn it on when no earlier step builds             |          | `false`     |
| `verify` | When the cache lacks a path: `warn` posts the link and logs it, `fail` fails the step, `off` does not ask |          | `warn`      |

### The comment

| Input         | Description                                                                            | Required | Default               |
| ------------- | -------------------------------------------------------------------------------------- | -------- | --------------------- |
| `comment`     | Post the link. Turn it off to use the `url` output for something else                  |          | `true`                |
| `prNumber`    | Pull request to comment on. Read from the event, so only a `workflow_run` job needs it |          | from the event        |
| `commit`      | Commit the link was built from, named in the comment                                   |          |                       |
| `githubToken` | Token the comment is posted with                                                       |          | `${{ github.token }}` |

### The link

| Input  | Description                                                                                 | Required | Default              |
| ------ | ------------------------------------------------------------------------------------------- | -------- | -------------------- |
| `site` | trynix deployment to link to                                                                |          | `https://trynix.dev` |
| `boot` | Link a boot that starts on open. Off, so scrolling past a comment does not begin a download |          | `false`              |

Outputs are `url`, `paths` and `published`.

## How it runs

Two steps, and the first is the one that matters.

It calls [tools/share-link.py](../tools/share-link.py) in this
repository — `uses: fzakaria/trynix@<ref>` checks out the whole
repository, so the script one level up is there to run. That resolves
each attribute to the store paths it names, asks the cache whether it
has them and whether a browser may read both the narinfo and the NAR,
and composes the URL.

Resolving means evaluating, not building. The normal shape is a
`nix build` earlier in the same job and a cache step that pushes what it
made, so the path is already there and asking nix to make it again would
at best be a no-op. `nix eval` on the attribute names the same path for
nothing. Set `build: true` when the workflow has no build step of its
own, and note that building reports every output nix installs while
evaluating reports the default one, so a multi-output package can differ
between the two.

Then the comment: one per pull request, found again by a
`<!-- trynix-preview -->` marker at the top of its body and edited in
place, so ten pushes leave one comment.

`verify` defaults to warning rather than failing because of when pushes
happen. `cachix/cachix-action` pushes in a post-job step, so at the
moment this action runs the paths are legitimately not in the cache yet.
The link is still correct and gets posted. Use `verify: fail` if you push
with an explicit step before this one and want a missing path to be an
error. A cache a browser cannot read is always a warning: that is a
header on someone else's server, not something the pull request did.

Inputs reach the shell as environment variables rather than as
expressions expanded into the script, so a quote in a value produces a
bad attribute name rather than a shell injection.

Runners need `nix`, plus `python3`, `jq` and `gh`. GitHub-hosted runners
have all four; a self-hosted one may not.

## The cache must allow cross-origin reads

The page fetches narinfos and NARs from the cache itself, so the cache
has to send `access-control-allow-origin` on both routes. A cache can be
public, correct, and still unreadable from a page.

```console
$ curl -sS -o /dev/null -D- https://my-cache.cachix.org/<digest>.narinfo | grep access-control
access-control-allow-origin: *
$ curl -sS -o /dev/null -D- https://my-cache.cachix.org/nar/<uuid>.nar.zst | grep access-control
access-control-allow-origin: *
```

`verify` asks the same question on every run and puts the answer in the
log. A cache with no public endpoint cannot work whatever its headers
say, which rules out anything backed by the GitHub Actions cache, and
neither can one that wants credentials: a link carries none.

## What the link is

The URL is the whole state of a boot, so the comment carries the preview
rather than pointing at one ([docs/design.md, "The
link"](../docs/design.md#the-link)).

```
https://trynix.dev/?path=/nix/store/…-my-package&cache=https://my-cache.cachix.org+my-cache-1:…
```

A store path on its own would not be enough. The page walks the closure
from narinfos, checks every signature, and downloads the NARs itself, so
it needs a cache that holds the path and the public key that vouches for
it. Both ride in the same link. That is why the link keeps working for
anyone you send it to, and after the pull request is merged, for as long
as the cache holds the path.

## Attributes

`attrs` takes one flake attribute per line, and each may be a package or
an app:

| attribute                     | what is built                      |
| ----------------------------- | ---------------------------------- |
| `.#my-package`                | every output the package installs  |
| `.#apps.x86_64-linux.my-tool` | the store path holding the program |

An app is not a derivation and cannot be built directly. Its `program`
names one, and that is what gets built and linked. Either way the link
carries a store path, and every program under its `bin/` is on the
guest's PATH.

The guest is x86_64 Linux. An `aarch64-darwin` build has nothing to run
it, so build for `x86_64-linux` on a Linux runner.

> The number that decides this is the **unpacked** closure, not the
> download. NARs are decompressed into the emulator's memory, so a
> 200 MB download can cost 800 MB of a budget that is about 1.2 GB
> ([docs/performance.md](../docs/performance.md#memory-and-how-large-a-closure-fits)).
> Check with `nix path-info -S`.

| unpacked closure  | page open to a shell |
| ----------------- | -------------------- |
| `hello`, 32 MiB   | ~3 s                 |
| `nodejs`, 219 MiB | 9 s                  |
| `llvm`, 739 MiB   | 17 s                 |
| over ~1.2 GB      | no VM at all         |

Under a couple of hundred megabytes a preview feels instant enough that
a reviewer will actually click it. Past that it still works and the wait
grows with the closure, which is a judgement call about your reviewers
rather than a limit. Over the budget the engine cannot instantiate and
the page fails outright, so a preview of something that large is worse
than no preview.

Only the paths your cache alone has are a cost you control. sqlelf's
closure is 29 paths and 28 of them are in cache.nixos.org already, so a
pull request pushes one path and the reviewer fetches the rest from the
default cache. A closure that is mostly nixpkgs is cheaper than its
total suggests, and everything large is kept in the browser, so a second
boot downloads nothing.

Reaching a shell is not the same as running your program, and for
anything with an interpreter behind it the second number is the larger
one. sqlelf boots from that 257 MiB closure and then takes over 25
seconds to print `--help`, because CPython and LIEF are doing their
imports under emulation. A compiled binary starts in a moment. This is
worth knowing before you promise a reviewer a quick look: what they wait
for is the first command, not the prompt.

## Fork pull requests

Use [examples/fork-auto.yml](examples/fork-auto.yml), with a cache that
exists only for previews and a cachix token scoped to that one cache.
Every pull request then gets a link without anyone pressing anything.

The reason this is fine and the reason it looks alarming are the same
fact. `pull_request` gives a fork's job no secrets and a read-only token,
and no repository setting changes that. GitHub does have a "Send secrets
to workflows from pull requests" checkbox, but it only takes effect for
forks of private repositories; for a public repository there is no toggle
at all. So the only way to hand a fork's build a push token is
`pull_request_target`, which runs in your repository's context. Check out
`refs/pull/<n>/head` there and you are running a contributor's code with
a token in the environment. A flake evaluates arbitrary code before it
builds anything, so assume they can read it. `actions/checkout` refuses
that checkout unless you pass `allow-unsafe-pr-checkout: true`, which is
GitHub naming the trade rather than a step to skip past.

What that costs depends on what the token can do, and this action is not
the one holding it — it takes no token, so the exposure is entirely your
push step's, and you get to make that as small as you like. Cachix issues
[per-cache tokens](https://docs.cachix.org/getting-started) with write
access to a single cache, so make a `my-project-previews` cache, mint a
token for it, and put nothing else in the job. The worst case is then
that someone fills a cache nobody substitutes from, and you delete it.
Set `permissions:` to `contents: read` and `pull-requests: write` and the
`GITHUB_TOKEN` cannot do much either. Your normal CI already runs fork
code on every `pull_request`; that one scoped token is the only new
exposure.

Two things to actually watch. Never reuse that cache's signing key for
anything you substitute from, because it will end up vouching for paths a
contributor's code produced. And `pull_request_target` runs immediately
for everyone, including a first-time contributor's first pull request —
GitHub's approval requirement does not apply to it. Automatic means
automatic.

If you can't take that trade, the alternative is
[examples/comment-triggered.yml](examples/comment-triggered.yml): a
maintainer types `/trynix` and an `issue_comment` workflow does the same
build, after checking that the commenter has write access. It runs from
the default branch, so a pull request cannot edit the workflow that
builds it, and the audit trail is a comment with a name on it. It is also
a chore, and it earns its place mainly on self-hosted runners, under a
policy that forbids `pull_request_target`, or when one token really is
too much to hand out. Adding `environment: previews` with required
reviewers to the automatic workflow gets you a button instead of a
comment if you prefer that shape.

A third route needs no trust at all: an untrusted `pull_request` job with
no secrets builds and uploads the closure as an artifact, and a
`workflow_run` job imports it, pushes, and runs this action with
`prNumber`. Untrusted code never sees a secret. It costs an artifact the
size of the closure and a second workflow to keep in step, and the cache
still ends up signing bytes a contributor's code produced, which is true
of all of these.

## Without CI

The same thing from a terminal, for a store path you have already pushed:

```console
$ nix run github:fzakaria/trynix#share-link -- --attr .#hello --cache my-cache
https://trynix.dev/?path=/nix/store/…-hello&cache=https://my-cache.cachix.org+my-cache-1:…
```

`--push` publishes first, `--verify` checks that the cache really has the
paths and that a browser may read them, and `--json` prints all of it.
[tools/share-link.py](../tools/share-link.py) is what the action runs;
the action adds the pull request and the comment.
