# Driving trynix from an agent

Most of trynix is already a link. The selection lives in the query
string ([design.md, "The link"](design.md#the-link)), so
`?pkg=ripgrep@14.1.0&boot=1` picks a version and boots it with no API
involved, in any browser.

The console is the exception. ghostty draws the terminal on a canvas,
so nothing the guest prints is in the DOM and there is no
accessibility tree to read it from. Two interfaces exist for that.

## WebMCP

[`site/js/webmcp.js`](../site/js/webmcp.js) registers the page's
operations as [WebMCP](https://github.com/webmachinelearning/webmcp)
tools on `document.modelContext`, so an agent driving the browser calls
them instead of synthesising clicks.

| tool              | what it does                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `page-state`      | whether a guest is running, what is selected, the caches, the link that reproduces the page |
| `search-packages` | attribute names in the nixpkgs-multiverse index                                             |
| `list-versions`   | every version of an attribute, marked with whether Hydra built it for x86\_64-linux         |
| `select-packages` | add attributes or store paths to the selection                                              |
| `set-caches`      | the extra binary caches to fetch from, each with its public key                             |
| `boot`            | fetch the closure and start the VM, resolving at the guest's prompt                         |
| `run-command`     | run a shell command in the guest, returning its output and exit status                      |
| `read-console`    | everything the guest has said, boot messages included                                       |

Once a guest is running, selecting more packages and calling `boot`
again adds them without a reboot, the same way the button does.

Support is thin: ChatGPT Desktop ships WebMCP, Chrome and Edge have it
behind an origin trial, Firefox and Safari have nothing. The page
feature-detects `document.modelContext` and registers nothing where it
is absent. `nix run .#webmcp-test -- --site result` calls every tool
against a real boot, through a polyfill, since no headless browser
ships the API.

## window.trynix

[`site/js/agent.js`](../site/js/agent.js) is the same access without
the browser API, on `window.trynix` once a guest is running. The
benchmark harnesses in `tools/` call it over CDP.

- `run(command, { timeoutMs })` resolves to `{ status, output, timedOut }`
- `transcript()` returns everything the guest has said
- `type(text)` sends raw bytes, for an interrupt or a partial line

`run` resolves whether the command succeeded, failed or outlived its
timeout. Each run is fenced between two lines the guest prints itself,
because the echo of a typed command wraps at the terminal's width and
cannot be searched for, and a command can print anything a simpler
marker would match.
