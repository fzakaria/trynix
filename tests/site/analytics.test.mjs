// Exercise analytics with a recording tag, without contacting Google.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLoadTelemetry,
  SelectionMethod,
  LoadOperation,
  LoadStage,
  BootMode,
} from "../../site/js/analytics.js";

// Record one load and verify named packages produce one request event.
test("load events report named packages and finish once", () => {
  const events = [];
  const send = (...args) => events.push(args);
  const load = createLoadTelemetry(
    [
      {
        attr: "hello",
        version: "2.12",
        selectionMethod: SelectionMethod.PICKER,
        storePath: "/nix/store/example",
      },
      { storePath: "/nix/store/example", label: "example" },
    ],
    LoadOperation.BOOT,
    send,
  );
  load.finish(LoadStage.READY, BootMode.SNAPSHOT);
  load.finish(LoadStage.READY, BootMode.SNAPSHOT);
  assert.deepEqual(
    events.map(([event]) => event),
    ["boot_started", "package_requested", "boot_ready", "cache_summary"],
  );
  assert.deepEqual(events[1][1], {
    package_name: "hello",
    package_version: "2.12",
    selection_method: "picker",
    operation: "boot",
  });
});

// Keep concurrent load counters separate and ignore work after completion.
test("cache summaries belong to their own load", () => {
  const events = [];
  const send = (...args) => events.push(args);
  const first = createLoadTelemetry([], LoadOperation.BOOT, send);
  const second = createLoadTelemetry([], LoadOperation.ADD, send);
  first.cacheRead("hit", 12);
  first.cacheRead("miss", 34);
  second.cacheRead("hit", 56);
  first.finish(LoadStage.DOWNLOAD, BootMode.UNKNOWN);
  first.cacheRead("hit", 100);
  second.finish(LoadStage.READY, BootMode.UNKNOWN);
  const summaries = events
    .filter(([event]) => event === "cache_summary")
    .map(([, params]) => params);
  assert.deepEqual(summaries, [
    {
      operation: "boot",
      cache_hits: 1,
      cache_misses: 1,
      cache_bytes: 12,
      fetched_bytes: 34,
    },
    {
      operation: "add",
      cache_hits: 1,
      cache_misses: 0,
      cache_bytes: 56,
      fetched_bytes: 0,
    },
  ]);
});

// Analytics must never prevent a boot when the tag is absent or throws.
test("analytics failures do not escape into the app", () => {
  assert.doesNotThrow(() => {
    createLoadTelemetry([], LoadOperation.BOOT).finish(LoadStage.READY);
    createLoadTelemetry([], LoadOperation.BOOT, () => {
      throw new Error("blocked");
    }).finish(LoadStage.DOWNLOAD);
  });
});

// Evaluate both HTML tags and verify the default Google configuration.
test("pages use the Google tag without metadata overrides", async () => {
  const { readFileSync } = await import("node:fs");
  const { runInNewContext } = await import("node:vm");
  for (const path of ["site/index.html", "site/bench/index.html"]) {
    const html = readFileSync(path, "utf8");
    const context = {
      location: { origin: "https://trynix.dev", pathname: "/" },
    };
    context.window = context;
    runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
    const config = context.dataLayer.find(([command]) => command === "config");
    assert.deepEqual(Array.from(config), ["config", "G-F9LCBV5XKM"]);
  }
});

// Use a fake Cache API and fetch to distinguish cached bytes from fetched bytes.
test("fetch callbacks report cache reuse and exclude prefetches", async (t) => {
  const { fetchWithProgress } = await import("../../site/js/net.js");
  const contents = new Map();
  t.mock.method(globalThis, "fetch", async () => new Response("network"));
  const previousCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  t.after(() => {
    if (previousCaches === undefined) {
      delete globalThis.caches;
      return;
    }
    Object.defineProperty(globalThis, "caches", previousCaches);
  });
  globalThis.caches = {
    open: async () => ({
      match: async (url) =>
        contents.has(url) ? new Response(contents.get(url)) : undefined,
      put: async (url, response) => contents.set(url, await response.text()),
      delete: async (url) => contents.delete(url),
    }),
  };
  const reads = [];
  const onCacheRead = (...args) => reads.push(args);
  await fetchWithProgress("https://example.test/prefetch");
  await fetchWithProgress("https://example.test/nar", { onCacheRead });
  await fetchWithProgress("https://example.test/nar", { onCacheRead });
  assert.deepEqual(reads, [
    ["miss", 7],
    ["hit", 7],
  ]);
});
