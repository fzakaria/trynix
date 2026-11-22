// What the unkernel guest's console drew, cut at each keyframe.
//
// A restored machine comes back with its memory, and with it the
// shell's idea of what is on the screen, but the screen itself is the
// page's: ghostty's state lives on this side. So the page keeps every
// byte the console sent, cut into one piece per keyframe (the bytes
// between the keyframe's parent and the keyframe), and rebuilds the
// screen at a keyframe by resetting the terminal and feeding it the
// pieces from the first keyframe down to that one. The pieces follow
// the keyframe tree, so a branch's screen never shows the future it
// left.
//
// The worker posts a keyframe's event at the moment it captures the
// memory, on the same channel as the output, so a cut falls exactly
// between the output from before the keyframe and from after it.

// How many bytes of a screen are replayed at most. More than this is
// past any scrollback the terminal keeps (terminal.js, 5000 lines).
export const SCREEN_LIMIT = 8 * 1024 * 1024;

export class ScreenLog {
  constructor({ limit = SCREEN_LIMIT } = {}) {
    this.limit = limit;
    // Each keyframe's piece and its parent, by id.
    this.pieces = new Map();
    // The keyframe the live screen continues from, and what was drawn
    // since.
    this.current = null;
    this.tail = [];
  }

  // Output from the console, as it is drawn.
  append(bytes) {
    this.tail.push(bytes);
  }

  // A keyframe was taken now, as a child of `parent`.
  frame(id, parent) {
    this.pieces.set(id, { parent, bytes: joined(this.tail) });
    this.current = id;
    this.tail = [];
  }

  // The machine went back to keyframe `id`; what is drawn next
  // continues from its screen.
  restored(id) {
    this.current = id;
    this.tail = [];
  }

  // The bytes that rebuild the screen at keyframe `id`.
  screenAt(id) {
    return this.cut(this.chain(id));
  }

  // The bytes that rebuild the live screen.
  live() {
    return this.cut([...this.chain(this.current), ...this.tail]);
  }

  // The pieces from the first keyframe down to `id`.
  chain(id) {
    const parts = [];
    for (let at = id; at !== null; at = this.pieces.get(at).parent) {
      parts.push(this.pieces.get(at).bytes);
    }
    return parts.reverse();
  }

  // Parts joined, keeping the last `limit` bytes.
  cut(parts) {
    const all = joined(parts);
    return all.length > this.limit ? all.slice(-this.limit) : all;
  }
}

function joined(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
