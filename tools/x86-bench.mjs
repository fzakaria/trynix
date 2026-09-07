#!/usr/bin/env node
// Runs the translator's benchmark suite (nix/x86-bench.nix): each
// program once with an empty translation cache, then again with the
// cache the first run filled, and checks its output against what the
// program printed natively when the suite was built.
//
//     nix run .#x86-bench -- [--suite <json>] [--runs <n>]
//         [--out <json>] [--summary <md>] [--baseline <json>]
//
// Two things are measured. The counters (blocks translated, syscalls,
// wasm emitted) are the same on every machine and say what the lane
// did; a baseline pins them so a change that translates more, or
// misses the cache, fails. The wall times say what a user waits and
// are only reported: they depend on the machine, so the baseline
// carries them for comparison and nothing gates on them.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const RUNNER = new URL("./x86run.mjs", import.meta.url).pathname;
const DEFAULT_RUNS = 3;
const STATS_LINE =
  /\[stats\] ([\d.]+) s, (\d+) regions translated \((\d+) blocks\), (\d+) from cache \((\d+) blocks\), ([\d.]+) MB of wasm, (\d+) ms translating, (\d+) syscalls/g;

// A translated run may not translate more blocks than the baseline did
// by this factor, or this many blocks, whichever allows more: some
// drift comes from the environment (a longer PATH, a different HOME)
// and from regions in writable mappings, which are never cached and
// depend on thread timing; a coverage regression is bigger.
const BLOCK_TOLERANCE = 1.1;
const BLOCK_SLACK = 500;
const blockLimit = (blocks) =>
  Math.max(blocks * BLOCK_TOLERANCE, blocks + BLOCK_SLACK);

function usage() {
  console.error(
    "usage: x86-bench [--suite <json>] [--runs <n>] [--out <json>] [--summary <md>] [--baseline <json>]",
  );
  process.exit(2);
}

const options = {
  suite: process.env.X86_BENCH_SUITE || null,
  runs: DEFAULT_RUNS,
  out: null,
  summary: null,
  baseline: null,
};
const args = process.argv.slice(2);
while (args.length > 0) {
  const flag = args.shift();
  const value = args.shift();
  if (value === undefined) {
    usage();
  }
  if (flag === "--suite") {
    options.suite = value;
  } else if (flag === "--runs") {
    options.runs = Number(value);
  } else if (flag === "--out") {
    options.out = value;
  } else if (flag === "--summary") {
    options.summary = value;
  } else if (flag === "--baseline") {
    options.baseline = value;
  } else {
    usage();
  }
}
if (options.suite === null) {
  usage();
}

// One run of one program through x86run: the wall time of the whole
// child, and the [stats] lines of every process it spawned summed.
function runOnce(program, cacheDir) {
  const started = performance.now();
  const child = spawnSync(
    process.execPath,
    [RUNNER, "--stats", "--cache", cacheDir, ...program.argv],
    {
      input: program.stdin,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, HOME: os.tmpdir() },
    },
  );
  const wall = (performance.now() - started) / 1000;

  const totals = {
    wall,
    regions: 0,
    blocks: 0,
    cachedRegions: 0,
    cachedBlocks: 0,
    wasmMB: 0,
    translateMs: 0,
    syscalls: 0,
    processes: 0,
  };
  for (const m of child.stderr.matchAll(STATS_LINE)) {
    totals.regions += Number(m[2]);
    totals.blocks += Number(m[3]);
    totals.cachedRegions += Number(m[4]);
    totals.cachedBlocks += Number(m[5]);
    totals.wasmMB += Number(m[6]);
    totals.translateMs += Number(m[7]);
    totals.syscalls += Number(m[8]);
    totals.processes += 1;
  }

  return {
    ...totals,
    status: child.status,
    stdout: child.stdout,
    stderr: child.stderr.replace(STATS_LINE, "").trim(),
  };
}

// The suite, program by program: a fresh cache directory, one cold run,
// then the warm runs, of which the fastest is the hot number.
const suite = JSON.parse(fs.readFileSync(options.suite, "utf8"));
const results = [];
let failed = false;
for (const program of suite.programs) {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "x86-bench-"));
  const cold = runOnce(program, cacheDir);
  const warm = [];
  for (let i = 0; i < options.runs; i++) {
    warm.push(runOnce(program, cacheDir));
  }
  fs.rmSync(cacheDir, { recursive: true });
  const hot = warm.reduce((a, b) => (b.wall < a.wall ? b : a));

  // Every run has to print what the native binary printed.
  const runs = [cold, ...warm];
  const wrong = runs.find(
    (r) => r.status !== program.status || r.stdout !== program.stdout,
  );
  const problem =
    wrong === undefined
      ? null
      : `expected status ${program.status} and ${JSON.stringify(program.stdout)}, ` +
        `got ${wrong.status} and ${JSON.stringify(wrong.stdout)}${wrong.stderr ? `; stderr: ${wrong.stderr}` : ""}`;
  if (problem !== null) {
    failed = true;
  }

  const strip = ({ stdout, stderr, status, ...rest }) => rest;
  results.push({
    name: program.name,
    lang: program.lang,
    cold: strip(cold),
    fill: strip(warm[0]),
    hot: strip(hot),
    problem,
  });
  console.error(
    `${program.name}: cold ${cold.wall.toFixed(2)} s, hot ${hot.wall.toFixed(2)} s, ` +
      `${cold.blocks} blocks translated cold, ${hot.blocks} hot${problem === null ? "" : ` -- ${problem}`}`,
  );
}

// Against the baseline: the counters may not grow past the tolerance,
// and a hot run may not translate what the baseline's hot run found in
// the cache.
const baseline =
  options.baseline === null
    ? null
    : JSON.parse(fs.readFileSync(options.baseline, "utf8"));
const regressions = [];
if (baseline !== null) {
  for (const r of results) {
    const b = baseline.programs.find((p) => p.name === r.name);
    if (b === undefined) {
      continue;
    }
    if (r.cold.blocks > blockLimit(b.cold.blocks)) {
      regressions.push(
        `${r.name}: ${r.cold.blocks} blocks translated cold, baseline ${b.cold.blocks}`,
      );
    }
    if (r.hot.blocks > blockLimit(b.hot.blocks)) {
      regressions.push(
        `${r.name}: ${r.hot.blocks} blocks translated hot (cache misses), baseline ${b.hot.blocks}`,
      );
    }
  }
  if (regressions.length > 0) {
    failed = true;
  }
}

// The report: a table a person reads, and the JSON a later run compares
// against.
const row = (r) => {
  const b = baseline?.programs.find((p) => p.name === r.name);
  const base =
    b === undefined
      ? ""
      : ` (${b.cold.wall.toFixed(2)} / ${b.hot.wall.toFixed(2)})`;
  return (
    `| ${r.name} | ${r.lang} | ${r.cold.wall.toFixed(2)} | ${r.hot.wall.toFixed(2)}${base} | ` +
    `${r.cold.blocks} | ${r.hot.blocks} | ${r.cold.wasmMB.toFixed(1)} | ${r.cold.syscalls} | ` +
    `${r.problem === null ? "ok" : "FAIL"} |`
  );
};
const table = [
  "| program | covers | cold s | hot s" +
    (baseline === null ? "" : " (baseline cold / hot)") +
    " | blocks cold | blocks hot | wasm MB | syscalls | output |",
  "|---|---|---|---|---|---|---|---|---|",
  ...results.map(row),
].join("\n");
const notes = [
  ...results
    .filter((r) => r.problem !== null)
    .map((r) => `- ${r.name}: ${r.problem}`),
  ...regressions.map((r) => `- regression: ${r}`),
];
const report = `${table}\n${notes.length > 0 ? `\n${notes.join("\n")}\n` : ""}`;
console.log(report);
if (options.summary !== null) {
  fs.appendFileSync(
    options.summary,
    `## Translated lane benchmark\n\n${report}\n`,
  );
}
if (options.out !== null) {
  fs.writeFileSync(
    options.out,
    `${JSON.stringify({ host: `${os.cpus()[0]?.model ?? "unknown"}, node ${process.version}`, runs: options.runs, programs: results }, null, 2)}\n`,
  );
}
process.exit(failed ? 1 : 0);
