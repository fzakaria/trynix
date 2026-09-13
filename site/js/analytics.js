// Record package requests and aggregate measurements for each load.
export const SelectionMethod = Object.freeze({
  PICKER: "picker",
  RANGE: "range",
  URL: "url",
  AGENT: "agent",
});
export const LoadOperation = Object.freeze({ BOOT: "boot", ADD: "add" });
export const LoadStage = Object.freeze({
  ISOLATION: "isolation",
  CLOSURE: "closure",
  DOWNLOAD: "download",
  GUEST: "guest",
  READY: "ready",
});
export const BootMode = Object.freeze({
  UNKNOWN: "unknown",
  SNAPSHOT: "snapshot",
  COLD: "cold",
});
export const CacheResult = Object.freeze({ HIT: "hit", MISS: "miss" });
export const AnalyticsEvent = Object.freeze({
  RANGE: "range_resolved",
  GRAIL: "grail_opened",
});
export const ResolutionOutcome = Object.freeze({
  SUCCESS: "success",
  PARTIAL: "partial",
  FAILED: "failed",
});
const PACKAGE_EVENT = "package_requested";
const CACHE_EVENT = "cache_summary";
const LOAD_EVENTS = Object.freeze({
  [LoadOperation.BOOT]: {
    start: "boot_started",
    ready: "boot_ready",
    failed: "boot_failed",
  },
  [LoadOperation.ADD]: {
    start: "packages_add_started",
    ready: "packages_add_ready",
    failed: "packages_add_failed",
  },
});

// A blocked or replaced tag must not affect the application.
export function track(event, parameters = {}) {
  try {
    globalThis.gtag?.("event", event, parameters);
  } catch {
    // Analytics delivery is optional.
  }
}

// Keep counters local to one operation so prefetches and retries cannot leak
// into the next boot. Only explicitly selected index packages carry names.
export function createLoadTelemetry(entries, operation, send = track) {
  const started = performance.now();
  const events = LOAD_EVENTS[operation];
  const counters = {
    operation,
    cache_hits: 0,
    cache_misses: 0,
    cache_bytes: 0,
    fetched_bytes: 0,
  };
  let finished = false;
  const emit = (event, parameters) => {
    try {
      send(event, parameters);
    } catch {
      // Analytics delivery is optional, including injected senders.
    }
  };

  emit(events.start, { package_count: entries.length });
  for (const entry of entries) {
    if (entry.attr === undefined || entry.version === undefined) {
      continue;
    }
    emit(PACKAGE_EVENT, {
      package_name: entry.attr,
      package_version: entry.version,
      selection_method: entry.selectionMethod ?? SelectionMethod.PICKER,
      operation,
    });
  }

  return {
    cacheRead(result, bytes) {
      if (finished) {
        return;
      }
      if (result === CacheResult.HIT) {
        counters.cache_hits += 1;
        counters.cache_bytes += bytes;
        return;
      }
      counters.cache_misses += 1;
      counters.fetched_bytes += bytes;
    },
    finish(stage, mode = BootMode.UNKNOWN) {
      if (finished) {
        return;
      }
      finished = true;
      emit(stage === LoadStage.READY ? events.ready : events.failed, {
        duration_ms: Math.round(performance.now() - started),
        package_count: entries.length,
        boot_mode: mode,
        stage,
      });
      emit(CACHE_EVENT, { ...counters });
    },
  };
}
