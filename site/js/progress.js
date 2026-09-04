// The boot screen's progress rows: one row per download stage, a bar
// where the total is known and a running byte count where it is not,
// and a state mark when a stage finishes or fails.

import { humanBytes } from "./format.js";

export class ProgressPanel {
  constructor(container) {
    this.container = container;
    container.replaceChildren();
  }

  row(label) {
    const el = document.createElement("div");
    el.className = "progress-row";

    const name = document.createElement("span");
    name.className = "label";
    name.textContent = label;

    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("div");
    fill.className = "fill";
    bar.append(fill);

    const text = document.createElement("span");
    text.className = "bytes muted";
    text.textContent = "…";

    el.append(name, bar, text);
    this.container.append(el);

    let total = null;
    let bytes = 0;

    const render = () => {
      if (total !== null && total > 0) {
        fill.style.width = `${Math.min(100, (bytes / total) * 100)}%`;
        text.textContent = `${humanBytes(bytes)} / ${humanBytes(total)}`;
      } else if (bytes > 0) {
        fill.style.width = "100%";
        text.textContent = humanBytes(bytes);
      }
    };

    return {
      setTotal(n) {
        total = n;
        render();
      },
      add(delta) {
        bytes += delta;
        render();
      },
      done(note) {
        el.classList.add("done");
        fill.style.width = "100%";
        text.textContent = note ?? (bytes > 0 ? humanBytes(bytes) : "done");
      },
      fail(message) {
        el.classList.add("failed");
        text.textContent = message;
      },
    };
  }
}
