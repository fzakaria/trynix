// The package picker: type an attribute, choose versions, collect them
// into a selection the boot mounts together. Everything is read from
// the multiverse index at runtime; nothing is bundled.
//
// A version the page cannot boot is shown rather than hidden. The index
// records every (attribute, version) pair nixpkgs ever shipped, and
// about one in nine of those pairs has no x86_64-linux store path at
// all: unfree, broken, or outside Hydra's jobset. Dropping those rows
// made the picker lie twice. The count beside the attribute stopped
// matching the list under it, and a reader who came for one exact
// version was told nothing about where that version went. So every
// version gets a row, a version with no build is struck through and
// cannot be picked, and one line under the list says why once.
//
// Every version number is a link to that version's page on
// nixmultiverse.com, which is where the long answer lives: the
// revisions that shipped it, the closure it pulled in, and the `nix
// run` line that fetches the same store path outside the browser. The
// number links out, the rest of the pill picks the version. Two targets
// in one pill, and an underline is the only mark either of them needs.
//
// The pick half is a toggle, and the pill of a chosen version is
// tinted. Clicking it again takes the version back out of the
// selection, so a misclick is undone where it happened rather than down
// at the chips.

import {
  bootable,
  multiverseUrl,
  searchAttrs,
  versionRowsOf,
} from "./multiverse.js";
import { humanBytes } from "./format.js";
import { SEARCH_LIMIT, SYSTEM } from "./config.js";

// How long the box sits still before a keystroke becomes a search.
const DEBOUNCE_MS = 120;

// What the pick half of the pill says when there is no closure size to
// show, which is the one case where the row would otherwise be blank.
const PICK_LABEL = "pick";

// What a version with no store path says instead of a size, and the
// line under the list that says it once at length. The label carries
// the whole message on a phone, where there is no hover and so no
// tooltip.
const NO_BUILD = "no build";
const NO_BUILD_NOTE = `no build: nixpkgs shipped that version and Hydra never built it for ${SYSTEM}, so there is nothing to fetch. Hydra builds neither unfree nor broken packages, and an attribute can also be taken out of its jobset.`;

export class PackagePicker {
  // The page owns the selection, since packages also arrive from the
  // range lane and from a pasted store path. So the picker asks whether
  // a version is in it (`selected`) and reports a click on one
  // (`onToggle`) rather than keeping its own copy.
  constructor({ input, results, selected, onToggle }) {
    this.input = input;
    this.results = results;
    this.selected = selected;
    this.onToggle = onToggle;
    // The bootable rows on screen, so a change in the selection can be
    // redrawn without rebuilding a hundred pills.
    this.rows = [];

    let timer;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.search(), DEBOUNCE_MS);
    });
  }

  async search() {
    const query = this.input.value.trim();
    this.rows = [];
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

    // An attribute row opens its version list and nothing else. The
    // link to the index waits until the list is open, where it belongs
    // to a version the reader has actually got in front of them.
    this.results.replaceChildren(
      ...matches.map((match) =>
        el(
          "button",
          {
            className: "attr",
            type: "button",
            onclick: () => this.expand(match.attr),
          },
          el("span", { className: "name" }, match.attr),
          el("span", { className: "muted" }, `${match.versionCount} versions`),
        ),
      ),
    );
  }

  // One attribute's versions, newest first, each a pill that adds the
  // version to the selection or takes it back out. The ones no boot can
  // reach are there to be read.
  async expand(attr) {
    this.results.replaceChildren(
      el("p", { className: "muted" }, `loading ${attr}…`),
    );
    this.rows = [];
    const versions = await versionRowsOf(attr);

    if (versions.length === 0) {
      this.results.replaceChildren(
        el(
          "p",
          { className: "muted" },
          `${attr} is not in the index. `,
          indexLink({ attr }, `look for ${attr} on nixmultiverse.com`),
        ),
      );
      return;
    }

    this.results.replaceChildren(
      summarize(attr, versions),
      ...versions.map((version) => this.versionRow(version)),
      ...legend(versions),
    );
  }

  // One version: its number, linked to the index, and the pick target
  // beside it. Both halves sit in one pill, so the row still reads as
  // one thing while the two clicks mean different things.
  versionRow(version) {
    const can = bootable(version);

    const number = indexLink(
      version,
      `${version.attr} ${version.version} on nixmultiverse.com`,
      version.version,
    );
    number.classList.add("name");

    const pick = el(
      "button",
      {
        className: "take",
        type: "button",
        disabled: !can,
        title: can ? version.storePath : NO_BUILD_NOTE,
        ariaLabel: `${version.attr} ${version.version} has no ${SYSTEM} build`,
        onclick: can ? () => this.onToggle(version) : undefined,
      },
      can
        ? version.closureSize > 0
          ? humanBytes(version.closureSize)
          : PICK_LABEL
        : NO_BUILD,
    );

    const pill = el(
      "span",
      { className: can ? "pick" : "pick dead" },
      number,
      pick,
    );

    if (!can) {
      return pill;
    }

    const row = { version, pill, pick };
    this.rows.push(row);
    mark(row, this.selected(version));
    return pill;
  }

  // The selection changed somewhere: on a chip's x, in the range lane,
  // or on a pill in this list. Whatever moved it, the pills say what is
  // chosen, so they are re-marked rather than rebuilt.
  refresh() {
    for (const row of this.rows) {
      mark(row, this.selected(row.version));
    }
  }
}

// What a pill says about a version that is already in the selection.
// The label keeps saying the closure size: swapping it for a word would
// change the pill's width, and a grid of a hundred pills reflowing
// under the cursor on every click is worse than the word is worth.
function mark({ version, pill, pick }, on) {
  pill.classList.toggle("on", on);
  pick.ariaPressed = String(on);
  pick.title = on
    ? `${version.storePath}. Click to take it back out of the selection.`
    : version.storePath;
  pick.ariaLabel = on
    ? `remove ${version.attr} ${version.version} from the selection`
    : `select ${version.attr} ${version.version}`;
}

// The list's header: the attribute, linked to its own page on the
// index, then how many versions there are and how many of them this
// page can boot. A reader who came for a version that cannot be picked
// learns from this line that the picker knows about it.
function summarize(attr, versions) {
  const parts = [`${versions.length} versions`];

  const unbuilt = versions.filter((v) => !bootable(v)).length;
  if (unbuilt > 0) {
    parts.push(`${unbuilt} with no ${SYSTEM} build`);
  }

  return el(
    "p",
    { className: "muted" },
    indexLink({ attr }, `${attr} on nixmultiverse.com`),
    ` · ${parts.join(" · ")}`,
  );
}

// Said once under the list, and only when the list holds a row it
// applies to.
function legend(versions) {
  if (versions.every(bootable)) {
    return [];
  }
  return [el("p", { className: "muted note" }, NO_BUILD_NOTE)];
}

// A link to what nixmultiverse.com says about an attribute, or about
// one version of it. Underlined rather than flagged with an icon: a
// hundred icons down a version list is a hundred things to look past.
function indexLink(target, title, text = target.attr) {
  return el("a", {
    className: "out",
    href: multiverseUrl(target),
    title,
    rel: "noopener",
    target: "_blank",
    textContent: text,
  });
}

// Minimal element helper: tag, properties, children.
function el(tag, props, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children.filter((c) => c !== "" && c !== null));
  return node;
}
