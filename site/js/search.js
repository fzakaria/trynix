// The package picker: type an attribute, choose versions, collect them
// into a selection the boot mounts together. Everything is read from
// the multiverse index at runtime; nothing is bundled.

import { searchAttrs, versionsOf } from "./multiverse.js";
import { humanBytes } from "./format.js";
import { SEARCH_LIMIT } from "./config.js";

// How long the box sits still before a keystroke becomes a search.
const DEBOUNCE_MS = 120;

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

  // One attribute's versions, newest first, each a button that adds it
  // to the selection. A version the census found gone is shown but not
  // selectable — its bytes are no longer in the cache.
  async expand(attr) {
    this.results.replaceChildren(
      el("p", { className: "muted" }, `loading ${attr}…`),
    );
    const versions = await versionsOf(attr);

    if (versions.length === 0) {
      this.results.replaceChildren(
        el(
          "p",
          { className: "muted" },
          `${attr} has no x86_64-linux build in the index`,
        ),
      );
      return;
    }

    this.results.replaceChildren(
      el("p", { className: "muted" }, `${attr} · ${versions.length} versions`),
      ...versions.map((version) => {
        const dead = version.alive === false;
        return el(
          "button",
          {
            className: dead ? "version dead" : "version",
            type: "button",
            disabled: dead,
            title: dead
              ? "the cache no longer serves this path"
              : version.storePath,
            onclick: () => this.onPick(version),
          },
          el("span", { className: "name" }, version.version),
          el(
            "span",
            { className: "muted" },
            dead
              ? "gone"
              : version.closureSize > 0
                ? humanBytes(version.closureSize)
                : "",
          ),
        );
      }),
    );
  }
}

// Minimal element helper: tag, properties, children.
function el(tag, props, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children.filter((c) => c !== "" && c !== null));
  return node;
}
