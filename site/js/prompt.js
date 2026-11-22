// The marks the unkernel guest's shell prints with each prompt.
//
// The scrubber puts a keyframe at every shell prompt and labels it
// with the command typed there, so the page has to know when a prompt
// is drawn and what was run before it. Nothing in a console stream
// says either. So the guest's prompt starts with a mark the page reads
// and removes before the terminal sees the output: an OSC sequence
// carrying the last command's exit status and the last line of the
// shell's history.
//
//   ESC ] 7701 ; <status> ; <history line> BEL
//
// The history line is busybox's `history` output for the command just
// run, "   12  ls -la", which gives both the command and its number. A
// new number means a command ran. The same number means either an
// empty line or a command that repeated the one before it, which
// busybox leaves out of the history; lineCounter, below, tells those
// two apart. The shell side is PROMPT_HOOK, below, which the manifest
// puts in front of PS1.

const OSC_NUMBER = "7701";
const OPEN = `\x1b]${OSC_NUMBER};`;
const CLOSE = "\x07";
const OPEN_BYTES = new TextEncoder().encode(OPEN);
const CLOSE_BYTE = CLOSE.charCodeAt(0);
const SEPARATOR = ";";

// How long a mark may be before the scanner decides it is not one and
// passes the bytes on: a command line far past any terminal's width.
const MARK_LIMIT = 4096;

// What goes in front of PS1, as the shell reads it: `\[` and `\]`
// tell the line editor the mark takes no columns, `$?` is the status,
// and the command substitution is the history's last line, cut out
// with parameter expansion so the prompt runs no program. The line
// editor expands backslash escapes in the prompt after the shell has
// expanded the rest, so the line's backslashes are doubled first, or
// `printf 'a\n'` would come back with a newline in it.
export const PROMPT_HOOK = `\\[\\033]${OSC_NUMBER};$?;$(h=$(history); h=\${h##*\n}; echo "\${h//\\\\/\\\\\\\\}")\\007\\]`;

// A mark as the shell prints it, for tests and for documentation.
export const promptMark = (status, historyLine) =>
  `${OPEN}${status}${SEPARATOR}${historyLine}${CLOSE}`;

const HISTORY_LINE = /^\s*(\d+)\s+(.*)$/s;

// One mark's text (between OPEN and CLOSE) as { status, number,
// command }; number is null when the history was empty.
function parse(text) {
  const at = text.indexOf(SEPARATOR);
  const status = Number(text.slice(0, at));
  const line = text.slice(at + 1);
  const entry = HISTORY_LINE.exec(line);
  if (entry === null) {
    return { status, number: null, command: line.trim() };
  }
  return { status, number: Number(entry[1]), command: entry[2].trim() };
}

// How many bytes at the end of `bytes` are the start of OPEN.
function partialOpen(bytes) {
  const longest = Math.min(OPEN_BYTES.length - 1, bytes.length);
  for (let length = longest; length > 0; length--) {
    const start = bytes.length - length;
    let matches = true;
    for (let i = 0; i < length; i++) {
      if (bytes[start + i] !== OPEN_BYTES[i]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return length;
    }
  }
  return 0;
}

// Where OPEN starts in `bytes` at or after `from`, or -1.
function findOpen(bytes, from) {
  for (let at = bytes.indexOf(OPEN_BYTES[0], from); at !== -1;) {
    if (at + OPEN_BYTES.length > bytes.length) {
      return -1;
    }
    let matches = true;
    for (let i = 1; i < OPEN_BYTES.length; i++) {
      if (bytes[at + i] !== OPEN_BYTES[i]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return at;
    }
    at = bytes.indexOf(OPEN_BYTES[0], at + 1);
  }
  return -1;
}

// A scanner over the console stream. feed() takes each piece as it
// arrives and returns the piece with every mark removed (`bytes`) and
// the marks read from it, each with `at`, its offset in `bytes`. A
// mark split across pieces is held back until its end arrives.
export function promptScanner() {
  const decoder = new TextDecoder();
  let held = new Uint8Array(0);

  return {
    feed(piece) {
      const bytes = new Uint8Array(held.length + piece.length);
      bytes.set(held);
      bytes.set(piece, held.length);
      held = new Uint8Array(0);

      const out = [];
      const marks = [];
      let length = 0;
      const emit = (part) => {
        out.push(part);
        length += part.length;
      };

      let from = 0;
      for (;;) {
        const open = findOpen(bytes, from);

        // No mark starts here: pass everything on, but hold back a
        // tail that could be the start of one.
        if (open === -1) {
          const tail = partialOpen(bytes.subarray(from));
          emit(bytes.subarray(from, bytes.length - tail));
          held = bytes.slice(bytes.length - tail);
          break;
        }

        emit(bytes.subarray(from, open));
        const close = bytes.indexOf(CLOSE_BYTE, open + OPEN_BYTES.length);

        // A mark whose end has not arrived is held, unless it has run
        // so long that it cannot be one.
        if (close === -1) {
          if (bytes.length - open > MARK_LIMIT) {
            emit(bytes.subarray(open));
          } else {
            held = bytes.slice(open);
          }
          break;
        }

        const text = decoder.decode(
          bytes.subarray(open + OPEN_BYTES.length, close),
        );
        marks.push({ ...parse(text), at: length });
        from = close + 1;
      }

      const clean = new Uint8Array(length);
      let offset = 0;
      for (const part of out) {
        clean.set(part, offset);
        offset += part.length;
      }
      return { bytes: clean, marks };
    },
  };
}

// The terminal's answer to the line editor's cursor question,
// ESC [ row ; col R: typed by the terminal, not by the reader.
const CURSOR_REPORT = /\x1b\[\d+;\d+R/g;
const INTERRUPT = "\x03";
const LINE_ENDS = new Set(["\r", "\n"]);

// The lines typed at the guest's shell, counted from what goes into the
// console.
//
// A prompt mark's history line says a command ran when it changes, but
// busybox's line editor leaves a command out of the history when it
// repeats the one before it ("Don't save dupes" in lineedit.c), so `ls`
// run three times leaves the history line as it was. So the machine
// also counts lines: any key and then Enter is a line, Enter on its own
// is not, nor is a line cancelled with Ctrl-C, nor the terminal's
// cursor report. Recalling a line with the up arrow and running it is a
// key and Enter, so it counts.
//
// Lines typed ahead, before the prompt they belong to is drawn, are
// counted against the prompt before it; a repeat typed ahead of its
// prompt shares that prompt's keyframe.
export function lineCounter() {
  let keys = false;
  let lines = 0;
  return {
    typed(data) {
      for (const char of data.replace(CURSOR_REPORT, "")) {
        if (char === INTERRUPT) {
          keys = false;
          continue;
        }
        if (LINE_ENDS.has(char)) {
          if (keys) {
            lines++;
          }
          keys = false;
          continue;
        }
        keys = true;
      }
    },
    // How many lines were typed since the last take.
    take() {
      const taken = lines;
      lines = 0;
      return taken;
    },
    // Forget everything typed: the machine went to a keyframe.
    reset() {
      keys = false;
      lines = 0;
    },
  };
}
