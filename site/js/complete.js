// Autocomplete for the range box, ported from grail's own so the two
// sites behave identically: a vertical dropdown under the input that
// completes the attribute the caret sits in, switches to completing
// versions once an "@" is typed, and takes arrow keys, Tab, Enter and
// Escape.
//
// The fragment logic is grail's (site/js/app.js): the caret's word, the
// "^" coexistence marker stripped, and for a version the text after the
// last range operator, so ">=3.1" completes "3.1" and leaves ">=" alone.

import { attrNames, versionsOf } from "./multiverse.js";
import { RANGE_COMPLETIONS } from "./config.js";

const RANGE_OPERATORS =
  /(?:.*(?:\|\||,|\.\.|>=|<=|>|<|=))?([A-Za-z0-9._+*-]*)$/;
const MIN_ATTR_PREFIX = 2;

export class RangeComplete {
  constructor({ input, dropdown, onAccept = () => {} }) {
    this.input = input;
    this.dropdown = dropdown;
    this.onAccept = onAccept;
    this.suggestions = [];
    this.selected = -1;

    input.addEventListener("input", () => this.refresh());
    input.addEventListener("blur", () => setTimeout(() => this.hide(), 150));
    input.addEventListener("keydown", (event) => this.onKeyDown(event));
    dropdown.addEventListener("mousedown", (event) => {
      const item = event.target.closest("li[data-i]");
      if (item !== null) {
        event.preventDefault();
        this.accept(Number(item.dataset.i));
      }
    });
  }

  // The word the caret sits in, and where the completable part starts.
  fragment() {
    const upto = this.input.value.slice(0, this.input.selectionStart);
    const wordStart = upto.search(/\S+$/);
    if (wordStart === -1) {
      return null;
    }
    const word = upto.slice(wordStart);

    const at = word.indexOf("@");
    if (at === -1) {
      const caret = word.startsWith("^") ? 1 : 0;
      return {
        mode: "attr",
        attr: null,
        start: wordStart + caret,
        prefix: word.slice(caret),
      };
    }

    const attr = word.slice(word.startsWith("^") ? 1 : 0, at);
    const match = RANGE_OPERATORS.exec(word.slice(at + 1));
    const prefix = match === null ? "" : match[1];
    return {
      mode: "version",
      attr,
      start: wordStart + word.length - prefix.length,
      prefix,
    };
  }

  async refresh() {
    const fragment = this.fragment();
    if (
      fragment === null ||
      (fragment.mode === "attr" && fragment.prefix.length < MIN_ATTR_PREFIX)
    ) {
      this.hide();
      return;
    }

    let pool;
    if (fragment.mode === "attr") {
      const names = await attrNames();
      pool = Object.keys(names).filter((name) =>
        name.startsWith(fragment.prefix),
      );
    } else {
      pool = (await versionsOf(fragment.attr))
        .map((version) => version.version)
        .filter((version) => version.startsWith(fragment.prefix));
    }

    this.suggestions = pool
      .slice(0, RANGE_COMPLETIONS)
      .map((text) => ({ text, fragment }));
    this.selected = -1;

    if (this.suggestions.length === 0) {
      this.hide();
      return;
    }

    this.dropdown.replaceChildren(
      ...this.suggestions.map(({ text }, i) => {
        const item = document.createElement("li");
        item.dataset.i = String(i);
        if (fragment.mode === "version") {
          const at = document.createElement("span");
          at.className = "muted";
          at.textContent = "@";
          item.append(at);
        }
        item.append(text);
        return item;
      }),
    );
    this.dropdown.hidden = false;
  }

  hide() {
    this.suggestions = [];
    this.selected = -1;
    this.dropdown.hidden = true;
  }

  accept(i) {
    const { text, fragment } = this.suggestions[i];
    const caret = this.input.selectionStart;
    const value = this.input.value;
    this.input.value =
      value.slice(0, fragment.start) + text + value.slice(caret);

    const position = fragment.start + text.length;
    this.input.setSelectionRange(position, position);
    this.input.focus();
    this.hide();
    this.onAccept();
  }

  move(delta) {
    if (this.suggestions.length === 0) {
      return;
    }
    this.selected =
      (this.selected + delta + this.suggestions.length) %
      this.suggestions.length;
    for (const [i, item] of [...this.dropdown.children].entries()) {
      item.classList.toggle("selected", i === this.selected);
    }
  }

  onKeyDown(event) {
    if (this.dropdown.hidden) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.move(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      this.move(-1);
      return;
    }
    if (event.key === "Escape") {
      this.hide();
      return;
    }
    // Enter with nothing highlighted submits the form instead.
    if (
      (event.key === "Tab" || event.key === "Enter") &&
      this.suggestions.length > 0
    ) {
      const i = this.selected === -1 ? 0 : this.selected;
      if (event.key === "Tab" || this.selected !== -1) {
        event.preventDefault();
        this.accept(i);
      }
    }
  }
}
