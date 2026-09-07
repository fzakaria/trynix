/*
 * The guest's end of the translated lane.
 *
 * A program the page has marked fast is a link in the bin farm to this
 * binary. Run from the guest's shell, it hands the command to the page
 * through the console: an escape sequence the page strips from the
 * console stream before the terminal draws it. The page then runs the
 * program through the translator in a Worker with the terminal
 * attached to it directly, so keystrokes and output never cross the
 * emulated serial line, and when the program exits the page sends the
 * status back the same way, as a sequence this stub reads from its
 * standard input in raw mode and exits with.
 *
 * The frames, each an OSC sequence ESC ] trynix ; <kind> ; <payload> BEL:
 *
 *   start   guest -> page   the request, base64 of NUL-separated fields
 *   exit    page -> guest   the exit status
 *   out     page -> guest   base64 output, when stdout is not the terminal
 *
 * When stdin is not the terminal (a pipe), its contents travel in the
 * request, up to a limit, and the program sees end of file after them.
 * Built static against musl by nix/exec-stub.nix.
 */

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>

#define STDIN_LIMIT (1 << 20)

static struct termios saved_termios;
static int have_termios = 0;

static void restore_terminal(void)
{
    if (have_termios) {
        tcsetattr(0, TCSANOW, &saved_termios);
    }
}

static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static char *encode(const unsigned char *in, size_t len)
{
    char *out = malloc(((len + 2) / 3) * 4 + 1);
    char *p = out;
    for (size_t i = 0; i < len; i += 3) {
        unsigned v = in[i] << 16;
        if (i + 1 < len) v |= in[i + 1] << 8;
        if (i + 2 < len) v |= in[i + 2];
        *p++ = B64[(v >> 18) & 63];
        *p++ = B64[(v >> 12) & 63];
        *p++ = i + 1 < len ? B64[(v >> 6) & 63] : '=';
        *p++ = i + 2 < len ? B64[v & 63] : '=';
    }
    *p = 0;
    return out;
}

static int decode_char(int c)
{
    const char *at = strchr(B64, c);
    return at && c ? (int)(at - B64) : -1;
}

static size_t decode(const char *in, unsigned char *out)
{
    size_t n = 0;
    unsigned v = 0;
    int bits = 0;
    for (; *in && *in != '='; in++) {
        int d = decode_char(*in);
        if (d < 0) {
            continue;
        }
        v = (v << 6) | d;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[n++] = (v >> bits) & 0xff;
        }
    }
    return n;
}

static void put(char **buf, size_t *len, size_t *cap, const char *s, size_t n)
{
    if (*len + n + 1 > *cap) {
        *cap = (*len + n + 1) * 2;
        *buf = realloc(*buf, *cap);
    }
    memcpy(*buf + *len, s, n);
    *len += n;
    (*buf)[(*len)++] = 0;
}

static void write_all(int fd, const char *p, size_t len)
{
    while (len > 0) {
        ssize_t n = write(fd, p, len);
        if (n <= 0) {
            return;
        }
        p += n;
        len -= n;
    }
}

extern char **environ;

int main(int argc, char **argv)
{
    const char *slash = strrchr(argv[0], '/');
    const char *program = slash ? slash + 1 : argv[0];
    int in_tty = isatty(0);
    int out_tty = isatty(1);

    /* The request: program, argv, "", env, "", cwd, "rows cols",
     * "tty"/"pipe" for stdin, "tty"/"pipe" for stdout, then piped stdin. */
    char *req = NULL;
    size_t len = 0;
    size_t cap = 0;
    put(&req, &len, &cap, program, strlen(program));
    for (int i = 1; i < argc; i++) {
        put(&req, &len, &cap, argv[i], strlen(argv[i]));
    }
    put(&req, &len, &cap, "", 0);
    for (char **e = environ; *e; e++) {
        put(&req, &len, &cap, *e, strlen(*e));
    }
    put(&req, &len, &cap, "", 0);
    char cwd[512];
    if (getcwd(cwd, sizeof cwd) == NULL) {
        strcpy(cwd, "/");
    }
    put(&req, &len, &cap, cwd, strlen(cwd));
    struct winsize ws = { 0 };
    ioctl(out_tty ? 1 : 2, TIOCGWINSZ, &ws);
    char size[64];
    snprintf(size, sizeof size, "%d %d", ws.ws_row, ws.ws_col);
    put(&req, &len, &cap, size, strlen(size));
    put(&req, &len, &cap, in_tty ? "tty" : "pipe", 4);
    put(&req, &len, &cap, out_tty ? "tty" : "pipe", 4);
    if (!in_tty) {
        static unsigned char piped[STDIN_LIMIT];
        size_t got = 0;
        for (;;) {
            ssize_t n = read(0, piped + got, sizeof piped - got);
            if (n <= 0 || got + n >= sizeof piped) {
                got += n > 0 ? n : 0;
                break;
            }
            got += n;
        }
        put(&req, &len, &cap, (const char *)piped, got);
    }

    /* The console the page listens on is the terminal whichever of
     * our descriptors it is; /dev/console is the serial line itself. */
    int console = open("/dev/console", O_RDWR | O_NOCTTY);
    if (console < 0) {
        console = out_tty ? 1 : 2;
    }
    if (tcgetattr(console, &saved_termios) == 0) {
        have_termios = 1;
        atexit(restore_terminal);
        struct termios raw = saved_termios;
        raw.c_lflag &= ~(ICANON | ECHO | ISIG | IEXTEN);
        raw.c_iflag &= ~(ICRNL | IXON);
        raw.c_cc[VMIN] = 1;
        raw.c_cc[VTIME] = 0;
        tcsetattr(console, TCSANOW, &raw);
    }

    char *encoded = encode((const unsigned char *)req, len);
    char *frame = malloc(strlen(encoded) + 32);
    sprintf(frame, "\x1b]trynix;start;%s\x07", encoded);
    write_all(console, frame, strlen(frame));
    free(frame);
    free(encoded);

    /* Frames back: exit, or output for a stdout that is not the terminal. */
    char line[1 << 16];
    size_t at = 0;
    int in_frame = 0;
    unsigned char raw_out[1 << 16];
    for (;;) {
        char c;
        ssize_t n = read(console, &c, 1);
        if (n <= 0) {
            if (n < 0 && errno == EINTR) {
                continue;
            }
            return 127;
        }
        if (!in_frame) {
            if (c == '\x1b') {
                in_frame = 1;
                at = 0;
            }
            continue;
        }
        if (c == '\x07' || at + 1 >= sizeof line) {
            line[at] = 0;
            in_frame = 0;
            if (strncmp(line, "]trynix;exit;", 13) == 0) {
                return atoi(line + 13);
            }
            if (strncmp(line, "]trynix;out;", 12) == 0) {
                size_t m = decode(line + 12, raw_out);
                write_all(1, (const char *)raw_out, m);
            }
            continue;
        }
        line[at++] = c;
    }
}
