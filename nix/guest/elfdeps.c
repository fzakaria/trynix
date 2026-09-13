/* elfdeps: print the files the dynamic loader would map for each ELF
 * executable named on the command line -- the executable itself, its
 * PT_INTERP, and every DT_NEEDED library, transitively, resolved the
 * way ld.so resolves them on a nix closure: through each object's own
 * DT_RUNPATH/DT_RPATH, then the directories every object seen so far
 * named. One path per line, deduplicated. A file that is not ELF is
 * printed alone. Built static for the busybox initramfs, where there
 * is no readelf and no ldd; init feeds the output to cat to warm the
 * 9p page cache before the visitor's first command needs it. */
#include <elf.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define MAX_FILES 512
#define MAX_DIRS 256
#define PATH_MAX_LEN 4096

static char *seen[MAX_FILES];
static int seen_count;
static char *dirs[MAX_DIRS];
static int dir_count;

static int is_seen(const char *path) {
  for (int i = 0; i < seen_count; i++) {
    if (strcmp(seen[i], path) == 0) {
      return 1;
    }
  }
  return 0;
}

static void add_dir(const char *dir) {
  for (int i = 0; i < dir_count; i++) {
    if (strcmp(dirs[i], dir) == 0) {
      return;
    }
  }
  if (dir_count < MAX_DIRS) {
    dirs[dir_count++] = strdup(dir);
  }
}

/* Every colon-separated directory in a RUNPATH/RPATH string; $ORIGIN
 * is not expanded, nix closures do not use it. */
static void add_dirs(const char *list) {
  char *copy = strdup(list);
  for (char *tok = strtok(copy, ":"); tok; tok = strtok(NULL, ":")) {
    if (tok[0] == '/') {
      add_dir(tok);
    }
  }
  free(copy);
}

static void visit(const char *path);

static void resolve_needed(const char *name) {
  char candidate[PATH_MAX_LEN];
  for (int i = 0; i < dir_count; i++) {
    snprintf(candidate, sizeof candidate, "%s/%s", dirs[i], name);
    struct stat st;
    if (stat(candidate, &st) == 0 && S_ISREG(st.st_mode)) {
      visit(candidate);
      return;
    }
  }
}

/* Translate a virtual address to a file offset through the PT_LOAD
 * segments. */
static long vaddr_to_offset(Elf64_Phdr *ph, int count, Elf64_Addr vaddr) {
  for (int i = 0; i < count; i++) {
    if (ph[i].p_type != PT_LOAD) {
      continue;
    }
    if (vaddr >= ph[i].p_vaddr && vaddr < ph[i].p_vaddr + ph[i].p_filesz) {
      return (long)(vaddr - ph[i].p_vaddr + ph[i].p_offset);
    }
  }
  return -1;
}

static void visit(const char *path) {
  if (is_seen(path) || seen_count >= MAX_FILES) {
    return;
  }
  seen[seen_count++] = strdup(path);
  puts(path);

  int fd = open(path, O_RDONLY);
  if (fd < 0) {
    return;
  }
  Elf64_Ehdr eh;
  if (pread(fd, &eh, sizeof eh, 0) != sizeof eh || memcmp(eh.e_ident, ELFMAG, SELFMAG) != 0 ||
      eh.e_ident[EI_CLASS] != ELFCLASS64) {
    close(fd);
    return;
  }
  Elf64_Phdr *ph = calloc(eh.e_phnum, sizeof *ph);
  if (pread(fd, ph, eh.e_phnum * sizeof *ph, eh.e_phoff) != (ssize_t)(eh.e_phnum * sizeof *ph)) {
    free(ph);
    close(fd);
    return;
  }

  /* The interpreter is a dependency like any other; its directory is
   * where glibc's own libraries live, which is the fallback search. */
  char interp[PATH_MAX_LEN] = "";
  Elf64_Phdr *dyn = NULL;
  for (int i = 0; i < eh.e_phnum; i++) {
    if (ph[i].p_type == PT_INTERP && ph[i].p_filesz < sizeof interp) {
      pread(fd, interp, ph[i].p_filesz, ph[i].p_offset);
      interp[ph[i].p_filesz] = 0;
    }
    if (ph[i].p_type == PT_DYNAMIC) {
      dyn = &ph[i];
    }
  }
  if (interp[0]) {
    char *slash = strrchr(interp, '/');
    if (slash) {
      *slash = 0;
      add_dir(interp);
      *slash = '/';
    }
  }

  /* Gather DT_STRTAB, DT_RUNPATH/RPATH and DT_NEEDED from the dynamic
   * segment. The search path is registered before the names are
   * resolved, so an object's own RUNPATH serves its own needs first. */
  char **needed = NULL;
  int needed_count = 0;
  if (dyn) {
    int count = dyn->p_filesz / sizeof(Elf64_Dyn);
    Elf64_Dyn *entries = calloc(count, sizeof *entries);
    pread(fd, entries, dyn->p_filesz, dyn->p_offset);
    long strtab = -1;
    for (int i = 0; i < count; i++) {
      if (entries[i].d_tag == DT_STRTAB) {
        strtab = vaddr_to_offset(ph, eh.e_phnum, entries[i].d_un.d_ptr);
      }
    }
    if (strtab >= 0) {
      char name[PATH_MAX_LEN];
      for (int i = 0; i < count; i++) {
        long tag = entries[i].d_tag;
        if (tag != DT_NEEDED && tag != DT_RUNPATH && tag != DT_RPATH) {
          continue;
        }
        ssize_t got = pread(fd, name, sizeof name - 1, strtab + entries[i].d_un.d_val);
        if (got <= 0) {
          continue;
        }
        name[got] = 0;
        if (tag == DT_NEEDED) {
          needed = realloc(needed, (needed_count + 1) * sizeof *needed);
          needed[needed_count++] = strdup(name);
        } else {
          add_dirs(name);
        }
      }
    }
    free(entries);
  }
  free(ph);
  close(fd);

  if (interp[0]) {
    visit(interp);
  }
  for (int i = 0; i < needed_count; i++) {
    resolve_needed(needed[i]);
    free(needed[i]);
  }
  free(needed);
}

int main(int argc, char **argv) {
  for (int i = 1; i < argc; i++) {
    char resolved[PATH_MAX_LEN];
    if (realpath(argv[i], resolved) == NULL) {
      continue;
    }
    visit(resolved);
  }
  return 0;
}
