// The timeline under the terminal: the unkernel guest's keyframes as
// marks on a strip, one per command, that the reader drags or steps
// back along to put the whole machine back where it was.
//
// The model (positionsOf, branchesOf) is plain functions over the
// keyframe tree, so the tests can read it without a page. The view
// (Timeline) draws it and turns pointer and key input into two
// requests to unkernel.js: preview a position (the terminal shows that
// keyframe's screen, the machine is untouched) and go to a position
// (the machine is restored there).
//
// Keyframes form a tree (keyframes.js). The strip shows one line of it:
// the keyframes from the first down to the current one, and on from
// there along the newest child each time, which after going back is
// the future that was left. A command run after going back makes a
// new child, so the strip then follows the new branch; the old one is
// offered in the branch list.

// The position of the live machine, at the end of the strip.
export const LIVE = "live";

const Kind = Object.freeze({
  PROMPT: "prompt",
  RUNNING: "running",
  DEPARTED: "departed",
});

const MS_PER_SECOND = 1000;

// The keyframes the strip shows when the machine continues from
// `current`: its ancestors, then on along the newest child.
function lineOf(frames, current) {
  if (current === null) {
    return [];
  }
  const up = [];
  for (let at = current; at !== null; at = frames.get(at).parent) {
    up.push(frames.get(at));
  }
  const line = up.reverse();

  const children = childrenOf(frames);
  for (let at = current; children.has(at);) {
    const newest = Math.max(...children.get(at));
    line.push(frames.get(newest));
    at = newest;
  }
  return line;
}

function childrenOf(frames) {
  const children = new Map();
  for (const frame of frames.values()) {
    if (frame.parent === null) {
      continue;
    }
    if (!children.has(frame.parent)) {
      children.set(frame.parent, []);
    }
    children.get(frame.parent).push(frame.id);
  }
  return children;
}

// The positions on the strip, left to right. Each is
//
//   { id, kind, command, seconds, minor, future, here, forks, at }
//
// `id` is a keyframe's id or LIVE. `command` is what was typed at a
// prompt (the command the next prompt reports), or for a running
// keyframe the command it was taken in; null when not known yet.
// `seconds` is how far into its command a running keyframe was.
// `minor` marks running keyframes, `future` the keyframes after the
// current one, `here` where the machine is, and `forks` a keyframe
// another branch leaves from.
export function positionsOf(frames, current) {
  const line = lineOf(frames, current);
  const children = childrenOf(frames);
  const onLine = new Set(line.map((frame) => frame.id));
  const currentIndex = line.findIndex((frame) => frame.id === current);

  // The command each keyframe belongs to: the one the next prompt
  // keyframe on the line reports. The prompt that started it is where
  // a running keyframe's seconds count from.
  const commandAfter = (index) => {
    for (let at = index + 1; at < line.length; at++) {
      if (line[at].kind === Kind.PROMPT) {
        return line[at].prompt?.command ?? null;
      }
    }
    return null;
  };
  const promptBefore = (index) => {
    for (let at = index; at >= 0; at--) {
      if (line[at].kind === Kind.PROMPT) {
        return line[at];
      }
    }
    return null;
  };

  const positions = [];
  line.forEach((frame, index) => {
    if (frame.failed) {
      return;
    }
    const running = frame.kind === Kind.RUNNING;
    const started = running ? promptBefore(index) : null;
    positions.push({
      id: frame.id,
      kind: frame.kind,
      command: frame.kind === Kind.DEPARTED ? null : commandAfter(index),
      seconds:
        started === null
          ? null
          : Math.round((frame.at - started.at) / MS_PER_SECOND),
      minor: running,
      future: index > currentIndex,
      here: false,
      forks: (children.get(frame.id) ?? []).some((id) => !onLine.has(id)),
      at: frame.at,
    });
  });

  // The live machine has a place of its own only at the end of the
  // line; after going back it is the restored keyframe.
  if (currentIndex === line.length - 1) {
    positions.push({
      id: LIVE,
      kind: LIVE,
      command: null,
      seconds: null,
      minor: false,
      future: false,
      here: true,
      forks: false,
      at: null,
    });
  } else {
    const at = positions.find((position) => position.id === current);
    if (at !== undefined) {
      at.here = true;
    }
  }
  return positions;
}

// The branches: one per leaf of the tree, by its newest keyframe that
// can be gone to, named after the last command run on it.
export function branchesOf(frames, current) {
  const children = childrenOf(frames);
  const onLine = new Set(lineOf(frames, current).map((frame) => frame.id));
  const branches = [];
  for (const frame of frames.values()) {
    if (children.has(frame.id)) {
      continue;
    }
    let tip = frame;
    while (tip.failed && tip.parent !== null) {
      tip = frames.get(tip.parent);
    }
    let named = tip;
    while (
      named !== undefined &&
      !(named.kind === Kind.PROMPT && named.prompt?.command)
    ) {
      named = frames.get(named.parent);
    }
    branches.push({
      tip: tip.id,
      command: named?.prompt.command ?? null,
      current: onLine.has(frame.id),
    });
  }
  return branches.sort((a, b) => a.tip - b.tip);
}

// ---------- the view ----------

// Room each prompt's mark gets on the strip; past what the width
// allows, the strip scrolls sideways. A label is drawn under a mark
// only when the marks are far enough apart for some of it to fit.
const MARK_SPACING_PX = 28;
const LABEL_MIN_SPACING_PX = 64;
const EDGE_PX = 14;

// How long the strip waits after the last arrow key before going to
// the position it stopped on, so stepping through several marks
// restores once.
const STEP_SETTLE_MS = 600;

const Key = Object.freeze({
  LEFT: "ArrowLeft",
  RIGHT: "ArrowRight",
  HOME: "Home",
  END: "End",
  ENTER: "Enter",
  SPACE: " ",
  ESCAPE: "Escape",
});

// What a position is called, in the caption and to a screen reader.
export function describe(position) {
  if (position === undefined) {
    return "";
  }
  switch (position.kind) {
    case LIVE:
      return "now";
    case Kind.DEPARTED:
      return "where you left";
    case Kind.RUNNING:
      return `${position.command ?? "a command"}, ${position.seconds} s in`;
    default:
      return position.command === null
        ? "the latest prompt"
        : `before ${position.command || "a new shell"}`;
  }
}

// The short label under a prompt's mark.
const labelOf = (position) =>
  position.kind === LIVE ? "now" : (position.command ?? "");

export class Timeline {
  // `element` is the timeline's container (index.html). `preview(id)`
  // shows a position's screen without touching the machine, `go(id)`
  // restores the machine there; both take a keyframe id or LIVE.
  constructor(element, { preview, go }) {
    this.element = element;
    this.preview = preview;
    this.go = go;
    this.positions = [];
    this.branches = [];
    this.selected = -1;
    this.busy = false;
    this.stepTimer = null;

    this.caption = element.querySelector("#timeline-caption");
    this.branchList = element.querySelector("#timeline-branches");
    this.scroller = element.querySelector("#timeline-scroll");
    this.track = element.querySelector("#timeline-track");

    this.listen();
  }

  // Draw the tree as the machine continues from `current`.
  // A position the reader is looking at, while dragging or while a
  // restore runs, stays selected across the update.
  update(frames, current) {
    const looking = this.positions[this.selected];
    const keep = looking !== undefined && (!looking.here || this.busy);
    this.positions = positionsOf(frames, current);
    this.branches = branchesOf(frames, current);
    const kept = keep
      ? this.positions.findIndex((position) => position.id === looking.id)
      : -1;
    this.selected = kept === -1 ? this.hereIndex() : kept;
    this.element.hidden = false;
    this.render();
  }

  // While a restore runs, input is ignored and the caption says so.
  setBusy(busy) {
    this.busy = busy;
    this.track.setAttribute("aria-busy", String(busy));
    this.renderCaption();
  }

  hereIndex() {
    return this.positions.findIndex((position) => position.here);
  }

  // Each position's place along the strip, from 0 to 1. Prompts and
  // the live end are spaced evenly; running keyframes sit between the
  // prompts around them in proportion to when they were taken.
  fractions() {
    const majors = this.positions
      .map((position, index) => ({ position, index }))
      .filter(({ position }) => !position.minor);
    const last = Math.max(1, majors.length - 1);
    const fractions = new Array(this.positions.length);
    majors.forEach(({ index }, rank) => {
      fractions[index] = rank / last;
    });
    this.positions.forEach((position, index) => {
      if (!position.minor) {
        return;
      }
      const before = majors.filter((m) => m.index < index).at(-1);
      const after = majors.find((m) => m.index > index);
      const from = before === undefined ? 0 : fractions[before.index];
      const to = after === undefined ? 1 : fractions[after.index];
      const startAt = before?.position.at ?? position.at;
      const endAt = after?.position.at ?? position.at;
      const share =
        endAt === null || endAt === startAt
          ? 0.5
          : (position.at - startAt) / (endAt - startAt);
      fractions[index] = from + (to - from) * Math.min(1, Math.max(0, share));
    });
    return fractions;
  }

  render() {
    const majors = this.positions.filter((position) => !position.minor);
    const width = Math.max(
      this.scroller.clientWidth,
      majors.length * MARK_SPACING_PX + 2 * EDGE_PX,
    );
    this.track.style.width = `${width}px`;
    const spacing = (width - 2 * EDGE_PX) / Math.max(1, majors.length - 1);
    const showLabels = spacing >= LABEL_MIN_SPACING_PX;
    this.track.classList.toggle("labelled", showLabels);
    this.fraction = this.fractions();

    const marks = this.positions.map((position, index) => {
      const mark = document.createElement("span");
      mark.className = "timeline-mark";
      mark.classList.toggle("minor", position.minor);
      mark.classList.toggle("future", position.future);
      mark.classList.toggle("here", position.here);
      mark.classList.toggle("forks", position.forks);
      mark.classList.toggle("live", position.id === LIVE);
      mark.style.left = `${EDGE_PX + this.fraction[index] * (width - 2 * EDGE_PX)}px`;
      mark.title = describe(position);
      if (showLabels && !position.minor) {
        const label = document.createElement("span");
        label.className = "timeline-label";
        label.textContent = labelOf(position);
        label.style.maxWidth = `${spacing - 8}px`;
        // The labels at the two ends hang inward, so the strip's edge
        // does not cut them.
        label.classList.toggle("first", index === 0);
        label.classList.toggle("last", index === this.positions.length - 1);
        mark.append(label);
      }
      return mark;
    });
    const handle = document.createElement("span");
    handle.className = "timeline-handle";
    this.handle = handle;
    this.track.replaceChildren(...marks, handle);
    this.renderSelection();
    this.renderBranches();
  }

  renderSelection() {
    const position = this.positions[this.selected];
    if (position === undefined) {
      return;
    }
    const width = this.track.clientWidth || parseFloat(this.track.style.width);
    const x = EDGE_PX + this.fraction[this.selected] * (width - 2 * EDGE_PX);
    this.handle.style.left = `${x}px`;
    this.handle.classList.toggle("away", !position.here);

    this.track.setAttribute("aria-valuemin", "0");
    this.track.setAttribute("aria-valuemax", String(this.positions.length - 1));
    this.track.setAttribute("aria-valuenow", String(this.selected));
    this.track.setAttribute("aria-valuetext", describe(position));

    // Keep the handle in view on a strip that scrolls.
    const left = this.scroller.scrollLeft;
    const visible = this.scroller.clientWidth;
    if (x < left + EDGE_PX || x > left + visible - EDGE_PX) {
      this.scroller.scrollLeft = x - visible / 2;
    }
    this.renderCaption();
  }

  renderCaption() {
    const position = this.positions[this.selected];
    const here = this.positions[this.hereIndex()];
    if (this.busy) {
      this.caption.textContent = `going to ${describe(position)}…`;
      return;
    }
    if (position === undefined) {
      this.caption.textContent = "";
      return;
    }
    if (position.here) {
      const future = this.positions.filter((p) => p.future).length;
      this.caption.textContent =
        future === 0
          ? describe(position)
          : `${describe(position)} · a new command starts a branch`;
      return;
    }
    this.caption.textContent = `${describe(position)} (release or Enter to go, Esc to stay at ${describe(here)})`;
  }

  renderBranches() {
    const list = this.branchList;
    list.hidden = this.branches.length < 2;
    if (list.hidden) {
      return;
    }
    const options = this.branches.map((branch, index) => {
      const option = document.createElement("option");
      option.value = String(branch.tip);
      option.textContent = `branch ${index + 1}: ${branch.command ?? "start"}`;
      option.selected = branch.current;
      return option;
    });
    list.replaceChildren(...options);
  }

  // The position nearest a pointer's x on the strip.
  indexAt(clientX) {
    const box = this.track.getBoundingClientRect();
    const width = box.width - 2 * EDGE_PX;
    const fraction = (clientX - box.left - EDGE_PX) / Math.max(1, width);
    let best = 0;
    this.fraction.forEach((at, index) => {
      if (Math.abs(at - fraction) < Math.abs(this.fraction[best] - fraction)) {
        best = index;
      }
    });
    return best;
  }

  // Show position `index` without going there.
  select(index) {
    const clamped = Math.min(this.positions.length - 1, Math.max(0, index));
    if (clamped === this.selected) {
      return;
    }
    this.selected = clamped;
    this.renderSelection();
    this.preview(this.positions[clamped].id);
  }

  // Go to the selected position: restore the machine there, or come
  // back to where it is.
  commit() {
    clearTimeout(this.stepTimer);
    const position = this.positions[this.selected];
    if (position === undefined || this.busy) {
      return;
    }
    if (position.here) {
      this.preview(LIVE);
      return;
    }
    this.go(position.id);
  }

  // Back to where the machine is, without going anywhere.
  cancel() {
    clearTimeout(this.stepTimer);
    this.selected = this.hereIndex();
    this.renderSelection();
    this.preview(LIVE);
  }

  listen() {
    const track = this.track;

    // Dragging previews each position the pointer passes; letting go
    // goes to the last one.
    track.addEventListener("pointerdown", (event) => {
      if (this.busy || this.positions.length === 0) {
        return;
      }
      event.preventDefault();
      track.focus({ preventScroll: true });
      track.setPointerCapture(event.pointerId);
      this.dragging = true;
      this.select(this.indexAt(event.clientX));
    });
    track.addEventListener("pointermove", (event) => {
      if (this.dragging) {
        this.select(this.indexAt(event.clientX));
      }
    });
    const release = () => {
      if (!this.dragging) {
        return;
      }
      this.dragging = false;
      this.commit();
    };
    track.addEventListener("pointerup", release);
    track.addEventListener("pointercancel", () => {
      this.dragging = false;
      this.cancel();
    });

    // The keyboard steps through the positions. The machine goes to the
    // one the steps stop on, once they stop; Enter goes at once and
    // Escape stays.
    track.addEventListener("keydown", (event) => {
      if (this.busy) {
        return;
      }
      const steps = {
        [Key.LEFT]: this.selected - 1,
        [Key.RIGHT]: this.selected + 1,
        [Key.HOME]: 0,
        [Key.END]: this.positions.length - 1,
      };
      if (event.key in steps) {
        event.preventDefault();
        this.select(steps[event.key]);
        clearTimeout(this.stepTimer);
        this.stepTimer = setTimeout(() => this.commit(), STEP_SETTLE_MS);
        return;
      }
      if (event.key === Key.ENTER || event.key === Key.SPACE) {
        event.preventDefault();
        this.commit();
        return;
      }
      if (event.key === Key.ESCAPE) {
        event.preventDefault();
        this.cancel();
      }
    });

    this.branchList.addEventListener("change", () => {
      this.go(Number(this.branchList.value));
    });

    new ResizeObserver(() => {
      if (this.positions.length > 0) {
        this.render();
      }
    }).observe(this.scroller);
  }
}
