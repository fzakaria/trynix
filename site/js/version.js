// Comparing the dotted versions in store path names, which the page
// reads to choose between two builds of one package (gldriver.js).

// A dotted version as numbers, for comparing: "2.42" -> [2, 42].
const numbers = (version) => version.split(".").map(Number);

// a - b, componentwise, a missing component counting as 0: negative when
// a is older, positive when it is newer, 0 when they are the same.
export function compareVersions(a, b) {
  const x = numbers(a);
  const y = numbers(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const difference = (x[i] ?? 0) - (y[i] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}
