/*
 * Make the kernel throw away the randomness it resumed with.
 *
 * Every visitor resumes the same snapshot, so every visitor starts with
 * the same frozen CRNG: the same base key, the same per-CPU keys, the
 * same pool. Extraction on the ready path is pure ChaCha over that key
 * and mixes nothing new in, so two guests running the same commands
 * would emit the same bytes -- the same boot_id, the same uuidgen, the
 * same ssh-keygen private key.
 *
 * What separates them is a reseed, because that is the one path that
 * pulls from the CPU's random instruction, which QEMU answers from the
 * browser's crypto.getRandomValues, per visitor. Today a reseed happens
 * to fire on the first extraction after a resume, but only because the
 * snapshot is taken at 0.93 s of guest uptime and the interval floor is
 * one second: a snapshot taken a few seconds later leaves the interval
 * unexpired and every visitor gets identical keys. That was measured,
 * not imagined -- a snapshot at 46 s of uptime gives six identical boot
 * ids out of six resumes.
 *
 * So ask for the reseed rather than inferring one. This is the only way
 * to force it: writing to /dev/urandom and RNDADDENTROPY both land on
 * credit_init_bits, which does nothing once the CRNG is ready.
 */
#include <fcntl.h>
#include <linux/random.h>
#include <sys/ioctl.h>
#include <unistd.h>

int main(void)
{
    int fd = open("/dev/urandom", O_RDONLY);
    if (fd < 0) {
        return 1;
    }

    /* Needs CAP_SYS_ADMIN, which init has. */
    if (ioctl(fd, RNDRESEEDCRNG) != 0) {
        close(fd);
        return 2;
    }

    close(fd);
    return 0;
}
