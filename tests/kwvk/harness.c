/* Runs kwvk's SPIR-V passes (spirv_for_host() in the patched icd.c,
 * which this file includes whole, statics and all) on one module, as
 * the driver's vkCreateShaderModule does before the module reaches the
 * page. Prints the storage bindings spirv_writable() calls writable
 * before and after the passes, and the descriptor bindings the module
 * declares after them, each as "set.binding", and writes the module the
 * passes give.
 *
 *   harness IN.spv OUT.spv */
#include ICD_C

/* The largest module and id the harness reads, in 32-bit words and ids. */
#define MAX_WORDS (1 << 20)
#define MAX_IDS (1 << 16)

/* The most writable bindings spirv_writable() is asked to report. */
#define MAX_WRITABLE 64

/* SPIR-V's numbers for what print_bindings() reads. */
enum {
	SPIRV_HEADER_WORDS = 5,
	OP_DECORATE = 71,
	DECORATION_BINDING = 33,
	DECORATION_DESCRIPTOR_SET = 34,
};

/* Which of a variable's two decorations print_bindings() has seen. */
enum {
	HAS_SET = 1,
	HAS_BINDING = 2,
};

/* Exit statuses: the module was read and written, or the arguments or
 * a file were not usable. */
enum {
	EXIT_OK = 0,
	EXIT_USAGE = 2,
};

/* Print "bindings:" and every id the module decorates with both a
 * descriptor set and a binding, as "set.binding". */
static void print_bindings(const uint32_t *w, size_t nw)
{
	static uint32_t set[MAX_IDS], bind[MAX_IDS];
	static uint8_t has[MAX_IDS];
	memset(has, 0, sizeof has);

	/* Every OpDecorate of a set or a binding, by the id it decorates. */
	for (size_t i = SPIRV_HEADER_WORDS; i < nw;) {
		uint32_t op = w[i] & 0xffff, len = w[i] >> 16;
		if (len == 0) {
			break;
		}
		if (op == OP_DECORATE && len >= 4 && w[i + 1] < MAX_IDS) {
			if (w[i + 2] == DECORATION_DESCRIPTOR_SET) {
				set[w[i + 1]] = w[i + 3];
				has[w[i + 1]] |= HAS_SET;
			}
			if (w[i + 2] == DECORATION_BINDING) {
				bind[w[i + 1]] = w[i + 3];
				has[w[i + 1]] |= HAS_BINDING;
			}
		}
		i += len;
	}

	/* The ids that have both, in id order. */
	printf("bindings:");
	for (uint32_t id = 0; id < MAX_IDS; id++) {
		if (has[id] != (HAS_SET | HAS_BINDING)) {
			continue;
		}
		printf(" %u.%u", set[id], bind[id]);
	}
	printf("\n");
}

/* Print `label` and the storage bindings spirv_writable() calls
 * writable, as "set.binding", or "unknown" when it cannot tell. */
static void print_writable(const char *label, const uint32_t *w, size_t nw)
{
	uint32_t out[MAX_WRITABLE];
	int n = spirv_writable(w, nw, out, MAX_WRITABLE);
	printf("%s", label);
	for (int i = 0; i < n; i++) {
		printf(" %u.%u", out[i] >> 16, out[i] & 0xffff);
	}
	if (n < 0) {
		printf(" unknown");
	}
	printf("\n");
}

int main(int argc, char **argv)
{
	if (argc != 3) {
		fprintf(stderr, "usage: %s IN.spv OUT.spv\n", argv[0]);
		return EXIT_USAGE;
	}

	/* The module, as the program would hand it to the driver. */
	FILE *f = fopen(argv[1], "rb");
	if (!f) {
		perror(argv[1]);
		return EXIT_USAGE;
	}
	static uint32_t w[MAX_WORDS];
	size_t nw = fread(w, sizeof w[0], MAX_WORDS, f);
	fclose(f);

	/* The passes, and what they changed. NULL from spirv_for_host()
	 * means no pass changed the module. */
	print_writable("before:", w, nw);
	size_t onw = 0;
	uint32_t *o = spirv_for_host(w, nw, &onw);
	const uint32_t *res = o ? o : w;
	size_t rnw = o ? onw : nw;
	print_writable("after:", res, rnw);
	print_bindings(res, rnw);

	/* The module the page would get, for spirv-val. */
	f = fopen(argv[2], "wb");
	if (!f) {
		perror(argv[2]);
		free(o);
		return EXIT_USAGE;
	}
	fwrite(res, sizeof res[0], rnw, f);
	fclose(f);
	free(o);
	return EXIT_OK;
}
