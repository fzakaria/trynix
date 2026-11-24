/*
 * zstd's reference decoder, wrapped for site/js/unzstd.js and compiled
 * freestanding to wasm32 (nix/unzstd-wasm.nix).
 *
 * The decoder streams. JavaScript writes the archive into the input
 * buffer a piece at a time, and each call to unzstd_decode leaves up
 * to a buffer's worth of the unpacked archive in the output buffer,
 * which JavaScript copies out before the next call. So the module's
 * memory holds the two buffers and one frame's window, whatever the
 * archive's size: firefox's 402 MB NAR, whose window is 8 MiB, costs
 * about 10 MiB here.
 *
 * Nothing is allocated with malloc. The decoder's state and its window
 * live in a workspace at the end of memory (ZSTD_initStaticDStream),
 * sized from each frame's header before any of the frame is decoded.
 * Memory grows when a frame needs more room than the frames before it.
 */
#define ZSTD_STATIC_LINKING_ONLY
#include "zstd.h"

#define EXPORT(name) __attribute__((export_name(name)))

/* How much of the archive JavaScript hands over at a time. */
#define INPUT_CAPACITY (1024 * 1024)

/*
 * How much of the unpacked archive one call to unzstd_decode leaves
 * for JavaScript to copy out.
 */
#define OUTPUT_CAPACITY (256 * 1024)

/*
 * The biggest window a frame may ask for: zstd's default decoder
 * limit, 128 MiB, which the zstd command enforces too unless it is
 * given --memory.
 */
#define WINDOW_SIZE_LIMIT (1ULL << ZSTD_WINDOWLOG_LIMIT_DEFAULT)

/*
 * The smallest window the workspace is sized for, whatever the frame
 * says. The decoder never works with less, and a skippable frame says
 * nothing at all.
 */
#define WINDOW_SIZE_FLOOR (1ULL << ZSTD_WINDOWLOG_MIN)

/* ZSTD_initStaticDStream wants its workspace 8-byte aligned. */
#define WORKSPACE_ALIGNMENT 8

/* The module's one memory, in wasm's 64 KiB pages. */
#define MEMORY_INDEX 0
#define WASM_PAGE_SIZE 65536ULL
#define MEMORY_GROW_FAILED ((size_t)-1)

/* What unzstd_decode returns when it fails; unzstd_message says why. */
#define DECODE_FAILED (-1)

#define MESSAGE_CAPACITY 128
#define DECIMAL_BASE 10
/* Enough decimal digits for any 64-bit number. */
#define DIGITS_CAPACITY 20

/* What setting up the next frame came to. */
enum frame_start { FRAME_READY, FRAME_NEEDS_INPUT, FRAME_FAILED };

/* Where the decoder stands in the archive. */
enum position { BETWEEN_FRAMES, WITHIN_FRAME };

/* Whether the decoder can go on without a new piece of the archive. */
enum appetite { HAS_INPUT, WANTS_INPUT };

/* The end of the module's static data, which the linker provides. */
extern unsigned char __heap_base;

static unsigned char input[INPUT_CAPACITY];
static unsigned char output[OUTPUT_CAPACITY];

static ZSTD_inBuffer piece = {input, 0, 0};
static ZSTD_DStream *stream;
static size_t workspace_size;
static enum position position = BETWEEN_FRAMES;
static enum appetite appetite = WANTS_INPUT;

static char message[MESSAGE_CAPACITY];
static size_t message_length;

/*
 * zstd's allocation functions. The path through this file never calls
 * them (the header comment says why). Should zstd ever reach for
 * malloc or calloc, the call fails as an allocation error.
 */
void *malloc(size_t size) {
  (void)size;
  return NULL;
}

void *calloc(size_t count, size_t size) {
  (void)count;
  (void)size;
  return NULL;
}

void free(void *pointer) { (void)pointer; }

/* Appends text to the message, cutting it at the buffer's end. */
static void say(const char *text) {
  while (*text != '\0' && message_length < MESSAGE_CAPACITY - 1) {
    message[message_length] = *text;
    message_length += 1;
    text += 1;
  }
  message[message_length] = '\0';
}

/* Appends a number to the message, in decimal. */
static void say_number(unsigned long long number) {
  char digits[DIGITS_CAPACITY + 1];
  size_t at = DIGITS_CAPACITY;
  digits[at] = '\0';
  do {
    at -= 1;
    digits[at] = (char)('0' + number % DECIMAL_BASE);
    number /= DECIMAL_BASE;
  } while (number > 0);
  say(&digits[at]);
}

/* Starts the message afresh with text. */
static void fail(const char *text) {
  message_length = 0;
  say(text);
}

/* Starts the message afresh with a zstd error's own name. */
static void fail_zstd(size_t error) { fail(ZSTD_getErrorName(error)); }

/*
 * Grows memory to at least `end` bytes. Returns 0 if memory cannot
 * grow that far.
 */
static int reach(unsigned long long end) {
  unsigned long long const have =
      __builtin_wasm_memory_size(MEMORY_INDEX) * WASM_PAGE_SIZE;
  if (end <= have) {
    return 1;
  }

  unsigned long long const pages =
      (end - have + WASM_PAGE_SIZE - 1) / WASM_PAGE_SIZE;
  return __builtin_wasm_memory_grow(MEMORY_INDEX, (size_t)pages) !=
         MEMORY_GROW_FAILED;
}

/*
 * Sets the stream up for the frame whose header starts the unread part
 * of the piece.
 */
static enum frame_start start_frame(void) {
  /*
   * zstd answers 0 when the whole header is in what is left of the
   * piece, and how many bytes it needs when the header runs past the
   * end. That header waits for the next piece, which JavaScript starts
   * at this frame's first byte.
   */
  ZSTD_FrameHeader header;
  size_t const needed =
      ZSTD_getFrameHeader(&header, input + piece.pos, piece.size - piece.pos);
  if (ZSTD_isError(needed)) {
    fail_zstd(needed);
    return FRAME_FAILED;
  }
  if (needed > 0) {
    return FRAME_NEEDS_INPUT;
  }

  /* A window past the limit is refused before memory is spent on it. */
  if (header.windowSize > WINDOW_SIZE_LIMIT) {
    fail("frame needs a ");
    say_number(header.windowSize);
    say("-byte window, past the ");
    say_number(WINDOW_SIZE_LIMIT);
    say("-byte limit");
    return FRAME_FAILED;
  }

  /*
   * The workspace an earlier frame was given serves every later frame
   * whose window fits in that workspace.
   */
  unsigned long long const window = header.windowSize < WINDOW_SIZE_FLOOR
                                        ? WINDOW_SIZE_FLOOR
                                        : header.windowSize;
  size_t const size = ZSTD_estimateDStreamSize((size_t)window);
  if (size <= workspace_size) {
    return FRAME_READY;
  }

  /*
   * A frame that needs more gets a bigger workspace, and a fresh stream
   * in the workspace. The stream being replaced stands between frames,
   * so no decoding state is lost.
   */
  size_t const base = ((size_t)&__heap_base + WORKSPACE_ALIGNMENT - 1) &
                      ~(size_t)(WORKSPACE_ALIGNMENT - 1);
  if (!reach((unsigned long long)base + size)) {
    fail("no memory for a frame with a ");
    say_number(header.windowSize);
    say("-byte window");
    return FRAME_FAILED;
  }
  stream = ZSTD_initStaticDStream((void *)base, size);
  if (stream == NULL) {
    fail("the zstd decoder would not start in its workspace");
    return FRAME_FAILED;
  }
  workspace_size = size;
  return FRAME_READY;
}

/* Where JavaScript writes each piece of the archive. */
EXPORT("unzstd_input") unsigned char *unzstd_input(void) { return input; }

/* How many bytes of the archive the input buffer holds. */
EXPORT("unzstd_input_capacity") size_t unzstd_input_capacity(void) {
  return INPUT_CAPACITY;
}

/* Where each call to unzstd_decode leaves what it unpacked. */
EXPORT("unzstd_output") unsigned char *unzstd_output(void) { return output; }

/*
 * Hands the decoder a new piece: `length` bytes, no more than the input
 * capacity, which JavaScript has written to the input buffer. A piece
 * starts at the first byte of the archive the decoder has not
 * consumed.
 */
EXPORT("unzstd_feed") void unzstd_feed(size_t length) {
  piece.size = length;
  piece.pos = 0;
  appetite = HAS_INPUT;
}

/* How much of the current piece the decoder has consumed. */
EXPORT("unzstd_consumed") size_t unzstd_consumed(void) { return piece.pos; }

/* Whether the decoder can go on without a new piece. */
EXPORT("unzstd_wants_input") int unzstd_wants_input(void) {
  return appetite == WANTS_INPUT;
}

/*
 * Whether everything handed over has been decoded: the decoder stands
 * between frames with nothing of the piece left.
 */
EXPORT("unzstd_finished") int unzstd_finished(void) {
  return position == BETWEEN_FRAMES && piece.pos == piece.size;
}

/* Why the last call to unzstd_decode failed. */
EXPORT("unzstd_message") const char *unzstd_message(void) { return message; }

/*
 * Decodes from the piece into the output buffer. Returns how many
 * bytes the call left in the output buffer, or DECODE_FAILED.
 */
EXPORT("unzstd_decode") int unzstd_decode(void) {
  ZSTD_outBuffer out = {output, OUTPUT_CAPACITY, 0};

  /*
   * Between frames, the next frame is set up from its header before any
   * of it reaches the stream.
   */
  if (position == BETWEEN_FRAMES) {
    if (piece.pos == piece.size) {
      appetite = WANTS_INPUT;
      return 0;
    }
    enum frame_start const started = start_frame();
    if (started == FRAME_FAILED) {
      return DECODE_FAILED;
    }
    if (started == FRAME_NEEDS_INPUT) {
      appetite = WANTS_INPUT;
      return 0;
    }
    position = WITHIN_FRAME;
  }

  size_t const hint = ZSTD_decompressStream(stream, &out, &piece);
  if (ZSTD_isError(hint)) {
    fail_zstd(hint);
    return DECODE_FAILED;
  }

  /*
   * zstd answers 0 once a frame is decoded and all of it flushed. A call
   * that used up the piece and still left room in the output buffer can
   * go no further without the next piece; one that filled the buffer
   * may have more to flush.
   */
  if (hint == 0) {
    position = BETWEEN_FRAMES;
  }
  appetite =
      piece.pos == piece.size && out.pos < out.size ? WANTS_INPUT : HAS_INPUT;
  return (int)out.pos;
}
