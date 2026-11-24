/*
 * The <stdlib.h> zstd's decoder includes, for the same build. zstd
 * declares its allocations through malloc, calloc and free, but the
 * path unzstd.c takes never reaches them: the decoder lives in a
 * workspace unzstd.c hands it (ZSTD_initStaticDStream). unzstd.c
 * defines all three anyway, with malloc and calloc failing, so a path
 * that did reach for the heap would fail as an allocation error.
 */
#ifndef UNZSTD_STDLIB_H
#define UNZSTD_STDLIB_H

#include <stddef.h>

void *malloc(size_t size);
void *calloc(size_t count, size_t size);
void free(void *pointer);

#endif
