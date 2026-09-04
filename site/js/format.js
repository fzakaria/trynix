// Number formatting shared across views.

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB"];
const BYTE_BASE = 1024;

// One decimal below 10, whole numbers above: "6.0 MiB", "28 MiB", "512 B".
export function humanBytes(n) {
  let value = n;
  let unit = 0;
  while (value >= BYTE_BASE && unit < BYTE_UNITS.length - 1) {
    value /= BYTE_BASE;
    unit += 1;
  }
  const digits = value >= 10 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}
