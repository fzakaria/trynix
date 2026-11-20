// What a guest has printed, kept as text, and ways to wait on it.
//
// Both engines feed one of these from the guest's terminal before
// anything is drawn. The boot flow waits on the record for the line
// that says the guest is up, and the driver in agent.js reads commands'
// output back out of the record, since the terminal itself is a canvas.

export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// How much of the transcript is kept.
const TRANSCRIPT_LIMIT = 65536;

// How long a marker is waited for before the wait gives up.
const HANDSHAKE_TIMEOUT_MS = 180000;

// How long the console must say nothing before the guest is taken to
// have finished coming up, and how long that is waited for at most.
const SETTLE_MS = 400;
const SETTLE_LIMIT_MS = 3000;

// Resolves once the guest has said nothing for `ms` — or after
// SETTLE_LIMIT_MS, since a guest that never stops talking is still a
// guest the reader should be given.
export async function settled(console_, ms = SETTLE_MS) {
  const deadline = Date.now() + SETTLE_LIMIT_MS;
  for (;;) {
    const idle = console_.quietFor();
    const left = deadline - Date.now();
    if (idle >= ms || left <= 0) {
      return;
    }
    await pause(Math.min(ms - idle, left));
  }
}

// Everything the guest has written, and a way to wait for a line in it.
//
// The transcript is capped: a guest that runs for an hour must not
// grow this without bound, and every marker is answered early in the
// run.
export function consoleRecorder({ limit = TRANSCRIPT_LIMIT } = {}) {
  let transcript = "";
  let spokeAt = Date.now();
  const waiters = [];

  const decoder = new TextDecoder();

  // One piece of what the guest printed.
  const hear = (data) => {
    spokeAt = Date.now();
    // A guest's output arrives as a string or as raw bytes, depending
    // on the engine and on what the guest wrote; concatenating the
    // bytes directly would stringify the array and match no marker
    // ever again.
    transcript +=
      typeof data === "string" ? data : decoder.decode(data, { stream: true });
    if (transcript.length > limit) {
      transcript = transcript.slice(-limit);
    }
    for (const waiter of waiters.splice(0)) {
      if (transcript.includes(waiter.marker)) {
        // The give-up timer goes with the wait, so a marker that came
        // leaves nothing behind to fire three minutes later.
        clearTimeout(waiter.timer);
        waiter.resolve();
      } else {
        waiters.push(waiter);
      }
    }
  };

  return {
    hear,

    transcript: () => transcript,

    // How long the console has said nothing (see settled).
    quietFor: () => Date.now() - spokeAt,

    // Resolves when the marker has been seen, and gives up quietly
    // after HANDSHAKE_TIMEOUT_MS: a guest this far off script has a
    // worse problem than a missing newline, and unveiling its console
    // is more useful than waiting forever.
    waitFor(marker) {
      if (transcript.includes(marker)) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const waiter = { marker, resolve };
        waiters.push(waiter);
        waiter.timer = setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at !== -1) {
            waiters.splice(at, 1);
          }
          resolve();
        }, HANDSHAKE_TIMEOUT_MS);
      });
    },
  };
}
