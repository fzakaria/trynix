// The intro's phrases with a short note under each (index.html, the
// .hint spans). Hovering shows a note (style.css); a click, or Enter or
// Space on the focused phrase, opens it and keeps it open, which is how
// a touch screen gets to read it. A second click, Escape, or a click
// anywhere else closes it.

// Close every open note.
function closeAll(phrases) {
  for (const phrase of phrases) {
    phrase.setAttribute("aria-expanded", "false");
  }
}

export function wireHints(root = document) {
  const phrases = [...root.querySelectorAll(".hint-phrase")];

  for (const phrase of phrases) {
    phrase.addEventListener("click", (event) => {
      // The click must not reach the document, which closes notes.
      event.stopPropagation();
      const open = phrase.getAttribute("aria-expanded") === "true";
      closeAll(phrases);
      phrase.setAttribute("aria-expanded", String(!open));
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
