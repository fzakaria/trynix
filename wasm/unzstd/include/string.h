/*
 * The <string.h> zstd's decoder includes, for its freestanding wasm32
 * build (nix/unzstd-wasm.nix), which links no C library. The decoder
 * calls memcpy, memmove and memset, and each one here is the
 * compiler's builtin, which -mbulk-memory compiles to wasm's own
 * memory.copy and memory.fill rather than to a call to a function no
 * one defines.
 */
#ifndef UNZSTD_STRING_H
#define UNZSTD_STRING_H

#include <stddef.h>

#define memcpy(destination, source, size)                                      \
  __builtin_memcpy((destination), (source), (size))
#define memmove(destination, source, size)                                     \
  __builtin_memmove((destination), (source), (size))
#define memset(destination, value, size)                                       \
  __builtin_memset((destination), (value), (size))

#endif
