// The package picker: type an attribute, choose versions, collect them
// into a selection the boot mounts together. Everything is read from
// the multiverse index at runtime; nothing is bundled.
//
// A version the page cannot boot is shown rather than hidden. The index
// records every (attribute, version) pair nixpkgs ever shipped, and
// about one in nine of them has no x86_64-linux store path at all —
// unfree, broken, or outside Hydra's jobset — while a much smaller
// number have a path the cache no longer serves. Dropping those rows
// silently makes the picker lie twice: the count beside the attribute
// stops matching the list under it, and a reader looking for the exact
// version they came for is told nothing about where it went. So every
// version gets a row, an unbootable one is dimmed and unselectable
// with the reason on it, and one line under the list explains the
// reasons once. Each row also links to that version's page on the
// index, which is where the long answer lives.

import {
  State,
  bootable,
  multiverseUrl,
  searchAttrs,
  versionRowsOf,
} from "./multiverse.js";
import { humanBytes } from "./format.js";
import { SEARCH_LIMIT, SYSTEM } from "./config.js";

// How long the box sits still before a keystroke becomes a search.
const DEBOUNCE_MS = 120;

// What each state says on the row, in its tooltip, and whether the row
// can be picked at all. The short label carries the whole message on a
// phone, where there is no hover and so no tooltip.
const STATES = {
  [State.LIVE]: {
    label: null,
    title: (v) => v.storePath,
  },
  [State.UNPROBED]: {
    label: "unprobed",
    title: (v) =>
      `${v.storePath} — the index has never probed this path, so trynix asks the cache when you pick it`,
  },
  [State.GONE]: {
    label: "gone",
    title: (v) =>
      `${v.storePath} — the index's census found this path missing from the cache, so its bytes cannot be fetched any more`,
  },
  [State.UNBUILT]: {
    label: "no build",
    title: (v) =>
      `no ${SYSTEM} store path is known for ${v.attr} ${v.version}: the version shipped in nixpkgs, but Hydra never built it here (it does not build unfree or broken packages) — so there is nothing to fetch`,
  },
};

export class PackagePicker {
  // onPick hears one version record each time a version is chosen; the
  // page owns the selection, since packages also arrive from the range
  // lane and from a pasted store path.
  constructor({ input, results, onPick }) {
    this.input = input;
    this.results = results;
    this.onPick = onPick;

    let timer;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.search(), DEBOUNCE_MS);
    });
  }

  async search() {
    const query = this.input.value.trim();
    if (query === "") {
      this.results.replaceChildren();
      return;
    }

    const matches = await searchAttrs(query, SEARCH_LIMIT);
    if (matches.length === 0) {
      this.results.replaceChildren(
        el("p", { className: "muted" }, "no such attribute"),
      );
      return;
    }

    this.results.replaceChildren(
      ...matches.map((match) =>
        row(
          el(
            "button",
            {
              className: "attr",
              type: "button",
              onclick: () => this.expand(match.attr),
            },
            el("span", { className: "name" }, match.attr),
            el(
              "span",
              { className: "muted" },
              `${match.versionCount} versions`,
            ),
          ),
          indexLink({ attr: match.attr }, `${match.attr} in the index`),
        ),
      ),
    );
  }

  // One attribute's versions, newest first, each a button that adds it
  // to the selection — except the ones no boot can reach, which are
  // there to be read.
  async expand(attr) {
    this.results.replaceChildren(
      el("p", { className: "muted" }, `loading ${attr}…`),
    );
    const versions = await versionRowsOf(attr);

    if (versions.length === 0) {
      this.results.replaceChildren(
        el("p", { className: "muted" }, `${attr} is not in the index`),
        indexLink({ attr }, `look for ${attr} in the index`),
      );
      return;
    }

    this.results.replaceChildren(
      el("p", { className: "muted" }, summarize(attr, versions)),
      ...versions.map((version) => this.versionRow(version)),
      ...legend(versions),
    );
  }

  versionRow(version) {
    const state = STATES[version.state];
    const can = bootable(version);
    return row(
      el(
        "button",
        {
          className: can ? "version" : "version dead",
          type: "button",
          disabled: !can,
          title: state.title(version),
          onclick: can ? () => this.onPick(version) : undefined,
        },
        el("span", { className: "name" }, version.version),
        el(
          "span",
          { className: "muted" },
          state.label ??
            (version.closureSize > 0 ? humanBytes(version.closureSize) : ""),
        ),
      ),
      indexLink(version, `${version.attr} ${version.version} in the index`),
    );
  }
}

// The list's header: how many versions there are, and how the ones that
// cannot boot break down. A reader who came for a version that is not
// selectable learns from this line that the picker knows about it.
function summarize(attr, versions) {
  const count = (state) => versions.filter((v) => v.state === state).length;
  const parts = [`${versions.length} versions`];

  const live = versions.filter(bootable).length;
  if (live !== versions.length) {
    parts.push(`${live} bootable`);
  }
  const unbuilt = count(State.UNBUILT);
  if (unbuilt > 0) {
    parts.push(`${unbuilt} with no ${SYSTEM} build`);
  }
  const gone = count(State.GONE);
  if (gone > 0) {
    parts.push(`${gone} gone from the cache`);
  }

  return `${attr} · ${parts.join(" · ")}`;
}

// Said once under the list rather than on every row, and only when the
// list holds a row it applies to.
function legend(versions) {
  const has = (state) => versions.some((v) => v.state === state);
  const lines = [];

  if (has(State.UNBUILT)) {
    lines.push(
      `no build — the index has no ${SYSTEM} store path for that version, so there is nothing to fetch: Hydra does not build unfree or broken packages, and an attribute can also be taken out of its jobset`,
    );
  }
  if (has(State.GONE)) {
    lines.push(
      "gone — the index's weekly census found the path missing from cache.nixos.org, so its bytes are no longer downloadable",
    );
  }
  if (has(State.UNPROBED)) {
    lines.push(
      "unprobed — nothing has fetched this path since it was indexed, so it is offered and checked against the cache the moment it is picked",
    );
  }

  return lines.map((line) => el("p", { className: "muted note" }, line));
}

// A row: the pick button, and the link to the same thing on the index.
// The link is a sibling rather than a child because a button may not
// contain one, and because a click on the row should pick the version
// rather than leave the page.
function row(button, link) {
  return el("span", { className: "pick" }, button, link);
}

function indexLink(target, title) {
  return el("a", {
    className: "index-link",
    href: multiverseUrl(target),
    title,
    rel: "noopener",
    target: "_blank",
    textContent: "↗",
  });
}

// Minimal element helper: tag, properties, children.
function el(tag, props, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children.filter((c) => c !== "" && c !== null));
  return node;
}
