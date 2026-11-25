// The intro's phrases with a short note under each (index.html, the
// .hint spans). Hovering shows a note (style.css); a click, or Enter or
// Space on the focused phrase, opens it and keeps it open, which is how
// a touch screen gets to read it. A second click, Escape, or a click
// anywhere else closes it.
//
// A phrase is a span with the button role rather than a <button>: a
// button is one box that cannot break across lines, so on a phone it
// pushed the words after it onto a line of their own. A span has none
// of a button's keys, so Enter and Space are wired here.

// The keys that open or close a focused phrase, as they press a button.
const PRESS_KEYS = new Set(["Enter", " "]);

// Close every open note.
function closeAll(phrases) {
  for (const phrase of phrases) {
    phrase.setAttribute("aria-expanded", "false");
  }
}

// Open the phrase's note, closing any other, or close it if it is open.
function toggle(phrase, phrases) {
  const open = phrase.getAttribute("aria-expanded") === "true";
  closeAll(phrases);
  phrase.setAttribute("aria-expanded", String(!open));
}

export function wireHints(root = document) {
  const phrases = [...root.querySelectorAll(".hint-phrase")];

  for (const phrase of phrases) {
    phrase.addEventListener("click", (event) => {
      // The click must not reach the document, which closes notes.
      event.stopPropagation();
      toggle(phrase, phrases);
    });

    // Enter and Space, without their defaults: Space would scroll the
    // page.
    phrase.addEventListener("keydown", (event) => {
      if (!PRESS_KEYS.has(event.key)) {
        return;
      }
      event.preventDefault();
      toggle(phrase, phrases);
    });
  }

  // A click inside a note keeps it open.
  for (const note of root.querySelectorAll(".hint-note")) {
    note.addEventListener("click", (event) => event.stopPropagation());
  }

  document.addEventListener("click", () => closeAll(phrases));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeAll(phrases);
    }
  });
}
