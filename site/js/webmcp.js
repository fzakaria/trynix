// WebMCP: the page's tools, declared for an agent driving the browser.
//
// https://github.com/webmachinelearning/webmcp. A page registers named
// functions with JSON Schema for their arguments, and an agent calls
// them directly instead of synthesising clicks. Chrome 149 and Edge
// 150 have it behind an origin trial, ChatGPT Desktop ships it, and
// everything else has nothing, so this whole module is a no-op unless
// document.modelContext exists. Nothing else on the page depends on
// it.
//
// Most of what these tools do is also reachable by writing a URL,
// because the selection lives in the query string (url.js). One thing
// is not: the terminal is a canvas, so what the guest printed never
// reaches the DOM and an agent has no way to read it by looking. That
// is what run-command and read-console are for, and they are the
// reason this file exists.

import { log } from "./log.js";

const NOT_BOOTED =
  "no guest is running; call boot first, then this command again";

// What search-packages returns when the caller does not say.
const DEFAULT_SEARCH_LIMIT = 20;

const text = (body) => ({ content: [{ type: "text", text: body }] });

const json = (value) => text(JSON.stringify(value, null, 2));

// The tools, in terms of `page`: the handful of operations app.js
// already performs for the reader, named here for an agent.
function toolsFor(page) {
  return [
    {
      name: "page-state",
      description:
        "What trynix currently has: whether a guest is running, which packages are selected, and the link that reproduces this page.",
      inputSchema: { type: "object", properties: {} },
      execute: async () => json(page.state()),
    },

    {
      name: "search-packages",
      description:
        "Search the nixpkgs-multiverse index for attribute names. Covers every package in 13 years of nixpkgs history, not only the current release.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "part of an attribute name" },
          limit: {
            type: "integer",
            description: `how many to return (default ${DEFAULT_SEARCH_LIMIT})`,
          },
        },
        required: ["query"],
      },
      execute: async ({ query, limit = DEFAULT_SEARCH_LIMIT }) =>
        json(await page.search(query, limit)),
    },

    {
      name: "list-versions",
      description:
        "Every version of one attribute that nixpkgs ever shipped, newest first, each marked with whether Hydra built it for x86_64-linux. A version with no build cannot be booted: there is nothing in the cache to fetch.",
      inputSchema: {
        type: "object",
        properties: {
          attr: {
            type: "string",
            description: "an attribute name, e.g. ripgrep",
          },
        },
        required: ["attr"],
      },
      execute: async ({ attr }) => json(await page.versions(attr)),
    },

    {
      name: "select-packages",
      description:
        "Add packages or raw store paths to the selection. A package named without a version takes the newest one the index can boot. Selecting does not boot; call boot afterwards.",
      inputSchema: {
        type: "object",
        properties: {
          packages: {
            type: "array",
            description: "attributes to select, optionally at a version",
            items: {
              type: "object",
              properties: {
                attr: { type: "string" },
                version: { type: "string" },
              },
              required: ["attr"],
            },
          },
          storePaths: {
            type: "array",
            description: "store paths to select verbatim",
            items: { type: "string" },
          },
        },
      },
      execute: async ({ packages = [], storePaths = [] }) => {
        await page.select({ packages, storePaths });
        return json(page.state());
      },
    },

    {
      name: "set-caches",
      description:
        "Replace the extra binary caches trynix fetches from, each with the public key that vouches for it. cache.nixos.org is always tried first and is not listed here. A cache is only reachable from a browser if it allows cross-origin reads, which cachix does.",
      inputSchema: {
        type: "object",
        properties: {
          caches: {
            type: "array",
            description: "the extra caches, in the order to try them",
            items: {
              type: "object",
              properties: {
                url: {
                  type: "string",
                  description: "e.g. https://my-cache.cachix.org",
                },
                key: {
                  type: "string",
                  description:
                    "its public key, e.g. my-cache.cachix.org-1:0Ma9…",
                },
              },
              required: ["url", "key"],
            },
          },
        },
        required: ["caches"],
      },
      execute: async ({ caches }) => json(page.caches(caches)),
    },

    {
      name: "boot",
      description:
        "Boot the selection in the tab: fetch its closure from cache.nixos.org into an x86_64 Linux VM and wait for a shell. Takes a few seconds on a warm cache and much longer on a cold one. Once a guest is running, selecting more packages and calling boot again adds them without rebooting.",
      inputSchema: { type: "object", properties: {} },
      execute: async () => text(await page.boot()),
    },

    {
      name: "run-command",
      description:
        "Run a shell command in the running guest and return its output and exit status. This is the only way to read the guest's console: the terminal is drawn on a canvas, so nothing it prints is in the page's DOM.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "the command to run" },
          timeoutMs: {
            type: "integer",
            description:
              "how long to wait before returning what it has printed so far",
          },
        },
        required: ["command"],
      },
      execute: async ({ command, timeoutMs }) => {
        const guest = page.guest();
        if (guest === null) {
          return text(NOT_BOOTED);
        }
        const result = await guest.run(
          command,
          timeoutMs === undefined ? {} : { timeoutMs },
        );
        return json(result);
      },
    },

    {
      name: "read-console",
      description:
        "Everything the guest has said so far, boot messages included. Use this when a boot or a command went wrong and the reason is further back than the last command's output.",
      inputSchema: { type: "object", properties: {} },
      execute: async () => {
        const guest = page.guest();
        return text(guest === null ? NOT_BOOTED : guest.transcript());
      },
    },
  ];
}

// Declare the tools, when the browser has somewhere to declare them.
//
// Registration is per tool and each one is independent, so a spec that
// has moved on from one of these arguments costs that tool rather than
// the page. Nothing here is awaited by the caller: a browser without
// the API must not delay the boot of a browser that has it.
export function registerTools(page) {
  const context = document.modelContext;
  if (context === undefined || typeof context.registerTool !== "function") {
    return;
  }

  const tools = toolsFor(page);
  for (const tool of tools) {
    Promise.resolve(context.registerTool(tool)).catch((err) => {
      log(`webmcp: ${tool.name} was refused: ${err.message}`);
    });
  }
  log(`webmcp: ${tools.length} tools declared`);
}
