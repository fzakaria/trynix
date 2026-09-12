// The benchmark page: draws bench/history.json, one record per published
// engine, as small multiples over the engine releases. tools/bench-history.py
// writes the file; this only reads it. Plain SVG, no library: a handful of
// lines over twenty points does not need one.

const HISTORY_URL = "history.json";

// Engine releases where something the charts should explain landed. The
// numeral is drawn on every chart at that release; the list under the
// charts says what it was. Keyed by release tag, so a record's position
// is found by lookup rather than by date arithmetic.
const REPO_URL = "https://github.com/fzakaria/trynix/";
const RELEASES_URL = REPO_URL + "releases/tag/";
const PATCHES_URL = REPO_URL + "blob/main/patches/";
const MILESTONES = [
  {
    tag: "engine-20260905-0511",
    label: "the store share is mounted with cache=loose",
  },
  {
    tag: "engine-20260905-0530",
    patch: "0002-9p-local-resolve-a-path-in-one-syscall-under-emscripten.patch",
    label: "a 9p path resolves in one syscall",
  },
  {
    tag: "engine-20260905-1727",
    label: "the main loop sleeps while the guest idles",
  },
  {
    tag: "engine-20260905-2136",
    label: "entropy: virtio-rng, rdrand, and a reseed at init",
  },
  {
    tag: "engine-20260905-2235",
    patch: "0003-count-the-clock-the-resumer-will-count.patch",
    label: "the guest's clock counts the host's clock",
  },
  {
    tag: "engine-20260906-2123",
    label: "the guest CPU is raised to x86-64-v3",
  },
  {
    tag: "engine-20260907-0100",
    patch: "0004-wasm-tcg-pass-ctpop-the-right-operands.patch",
    label: "POPCNT computes the right operands",
  },
  {
    tag: "engine-20260909-1605",
    patch: "0006-wasm32-batch-chain-locals.patch",
    label:
      "blocks compile in batches, chain by tail call, keep registers in locals",
  },
  {
    tag: "engine-20260909-1943",
    patch: "0007-wasm32-cached-chains-direct-calls-mul64.patch",
    label:
      "a jump caches its successor, calls inside a batch go direct, 64-bit multiplies inline",
  },
  {
    tag: "engine-20260912-2220",
    label: "the guest kernel moves from Linux 6.1 to 7.2.5",
  },
];

// The suite exec-bench runs, in the order the charts show them.
const PACKAGES = ["hello", "ripgrep", "jujutsu", "python", "opencode"];

// The instruction classes docs/engine-execution.md reads, and what each
// isolates. The rest of emubench's rows are in the table.
const CLASSES = [
  ["alu", "one compiled block"],
  ["alu2", "two blocks per iteration"],
  ["alu4", "four blocks per iteration"],
  ["call", "call and return"],
  ["indirect", "computed jump"],
  ["mem", "TLB fast path"],
  ["syscall", "guest syscall"],
  ["cold50k/p2", "code run twice: the interpreter"],
  ["cold2k/p1600", "2000 compiled blocks, dispersed"],
];

const SERIES_COLORS = ["var(--series-1)", "var(--series-2)"];
const PANEL_WIDTH = 320;
const PANEL_HEIGHT = 200;
// the top band holds the title, its subtitle, and the milestone numerals.
// the left band holds the y tick labels and nothing else, so it is only as
// wide as the widest one ("1.25", 24 units) plus TICK_LABEL_GAP: any wider
// and the plot sits visibly off-centre once a panel is a whole phone screen.
const MARGIN = { top: 42, right: 12, bottom: 28, left: 32 };
const TICK_LABEL_GAP = 6;
const TITLE_Y = 12;
const SUBTITLE_Y = 25;
const MIN_TICK_GAP = 44;
const MARKER_RADIUS = 4;
const HOVER_RADIUS = 6;
const LABEL_OFFSET = 7;
const GRID_LINES = 4;
const SVG = "http://www.w3.org/2000/svg";

function el(name, attrs = {}, children = []) {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, value);
  }
  for (const child of children) {
    node.append(child);
  }
  return node;
}

function html(name, attrs = {}, children = []) {
  const node = document.createElement(name);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, value);
  }
  for (const child of children) {
    node.append(child);
  }
  return node;
}

// The change a release carries, if the charts mark one there.
function milestoneFor(tag) {
  const milestone = MILESTONES.find((m) => m.tag === tag);
  return milestone ?? null;
}

// What changed, as the table and the tooltip say it: the patch as a link
// when there is one, then the description.
function changeDescription(milestone) {
  const parts = [];
  if (milestone.patch) {
    parts.push(
      html("a", { href: PATCHES_URL + milestone.patch }, [
        `patch ${milestone.patch.slice(0, 4)}`,
      ]),
      ": ",
    );
  }
  parts.push(milestone.label);
  return parts;
}

// A release tag as a link to the release that holds the engine.
function tagLink(tag) {
  return html("a", { href: RELEASES_URL + tag, class: "tag" }, [
    html("code", {}, [tag]),
  ]);
}

function format(value, unit) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "–";
  }
  if (unit === "s") {
    return value >= 100
      ? `${value.toFixed(0)} s`
      : value >= 10
        ? `${value.toFixed(1)} s`
        : `${value.toFixed(2)} s`;
  }
  if (unit === "mips") {
    return `${value.toFixed(value >= 100 ? 0 : 1)} mips`;
  }
  if (unit === "MiB") {
    return `${value.toFixed(0)} MiB`;
  }
  return String(value);
}

// Accessors over a record. Every one returns null when the record has no
// such measurement, which the charts draw as a gap.
function execResult(record, name) {
  return (record.exec?.results ?? []).find((r) => r.name === name) ?? null;
}

// A command that did not exit 0 measured nothing: on the engines whose
// guest CPU was qemu64, opencode dies on SIGILL in a second, and that
// second is not a speed.
function wall(record, name, phase) {
  const measurement = execResult(record, name)?.[phase];
  if (!measurement || measurement.status !== 0) {
    return null;
  }
  return typeof measurement.wall_seconds === "number"
    ? measurement.wall_seconds
    : null;
}

// For the table: a run's wall time however it ended, with the exit
// status when that was not 0, so a crash after five minutes reads as
// what it was rather than as a dash.
function wallCell(record, name, phase) {
  const measurement = execResult(record, name)?.[phase];
  if (!measurement || typeof measurement.wall_seconds !== "number") {
    return format(null, "s");
  }
  const text = format(measurement.wall_seconds, "s");
  return measurement.status === 0
    ? text
    : `${text} (exit ${measurement.status ?? "?"})`;
}

function bootSeconds(record) {
  const boots = (record.exec?.results ?? [])
    .map((r) => r.shell_seconds)
    .filter((v) => typeof v === "number")
    .sort((a, b) => a - b);
  if (boots.length === 0) {
    return null;
  }
  const mid = Math.floor(boots.length / 2);
  return boots.length % 2 ? boots[mid] : (boots[mid - 1] + boots[mid]) / 2;
}

// A row's throughput; zero is not one (the page-fault row counts no
// instructions, only nanoseconds).
function mips(record, name) {
  const value = record.emubench?.rows?.[name]?.mips_host;
  return typeof value === "number" && value > 0 ? value : null;
}

// For the table: a row's mips, or its nanoseconds per iteration when
// that is what it measured.
function mipsCell(record, name) {
  const row = record.emubench?.rows?.[name];
  if (!row) {
    return format(null, "mips");
  }
  if (row.mips_host > 0) {
    return format(row.mips_host, "mips");
  }
  return `${row.ns_per_iter.toFixed(0)} ns/iter`;
}

// One small multiple: `series` is [{label, values: number|null per record}].
function panel(title, subtitle, records, series, unit, tooltipHost) {
  const plotWidth = PANEL_WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = PANEL_HEIGHT - MARGIN.top - MARGIN.bottom;
  const n = records.length;
  const x = (i) =>
    MARGIN.left + (n > 1 ? (i * plotWidth) / (n - 1) : plotWidth / 2);
  const max = Math.max(
    1e-9,
    ...series.flatMap((s) => s.values.filter((v) => v !== null)),
  );
  const top = niceCeiling(max);
  const y = (v) => MARGIN.top + plotHeight - (v / top) * plotHeight;

  const svg = el("svg", {
    viewBox: `0 0 ${PANEL_WIDTH} ${PANEL_HEIGHT}`,
    class: "panel",
    role: "img",
    "aria-label": `${title}: ${subtitle}`,
  });

  // grid: hairlines at round values, labelled on the left
  for (let g = 0; g <= GRID_LINES; g++) {
    const value = (top * g) / GRID_LINES;
    svg.append(
      el("line", {
        x1: MARGIN.left,
        x2: PANEL_WIDTH - MARGIN.right,
        y1: y(value),
        y2: y(value),
        class: g === 0 ? "axis" : "grid",
      }),
    );
    svg.append(
      el(
        "text",
        {
          x: MARGIN.left - TICK_LABEL_GAP,
          y: y(value) + 3,
          class: "tick",
          "text-anchor": "end",
        },
        [String(axisLabel(value))],
      ),
    );
  }

  // no x labels: the points are releases in order, and the tooltip names
  // the one under the pointer

  // milestones: a hairline and a numeral at the release they landed in
  MILESTONES.forEach((milestone) => {
    const i = records.findIndex((r) => r.tag === milestone.tag);
    if (i < 0) {
      return;
    }
    svg.append(
      el("line", {
        x1: x(i),
        x2: x(i),
        y1: MARGIN.top - 4,
        y2: MARGIN.top + plotHeight,
        class: "milestone",
      }),
    );
  });

  // the lines, broken at gaps, and a marker per point
  series.forEach((s, k) => {
    let d = "";
    let pen = false;
    s.values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    svg.append(
      el("path", { d, class: "series", style: `stroke:${SERIES_COLORS[k]}` }),
    );
    s.values.forEach((v, i) => {
      if (v === null) {
        return;
      }
      svg.append(
        el("circle", {
          cx: x(i),
          cy: y(v),
          r: MARKER_RADIUS,
          class: "marker",
          style: `fill:${SERIES_COLORS[k]}`,
        }),
      );
    });
  });

  // the title and what the panel isolates, and a direct label on each
  // series' last point. the header sits flush with the panel's left edge,
  // not the plot's, so it lines up with the prose above the grid.
  svg.append(el("text", { x: 0, y: TITLE_Y, class: "title" }, [title]));
  svg.append(
    el("text", { x: 0, y: SUBTITLE_Y, class: "subtitle" }, [subtitle]),
  );
  if (series.length > 1) {
    const ends = series
      .map((s, k) => {
        const i = s.values
          .map((v, j) => (v === null ? -1 : j))
          .reduce((a, b) => Math.max(a, b), -1);
        return i < 0 ? null : { k, label: s.label, x: x(i), y: y(s.values[i]) };
      })
      .filter((e) => e !== null)
      .sort((a, b) => a.y - b.y);
    let previous = -Infinity;
    for (const end of ends) {
      // above the point, unless that lands on the previous label
      let labelY = end.y - LABEL_OFFSET;
      if (labelY - previous < LABEL_OFFSET) {
        labelY = end.y + LABEL_OFFSET + 3;
      }
      previous = labelY;
      svg.append(
        el(
          "text",
          {
            x: end.x - 6,
            y: labelY,
            class: "end-label",
            "text-anchor": "end",
            style: `fill:${SERIES_COLORS[end.k]}`,
          },
          [end.label],
        ),
      );
    }
  }

  // hover: the nearest release, a crosshair, and the values in a tooltip
  const cursor = el("line", {
    y1: MARGIN.top,
    y2: MARGIN.top + plotHeight,
    class: "cursor",
  });
  cursor.style.display = "none";
  svg.append(cursor);
  const hits = el("rect", {
    x: MARGIN.left - HOVER_RADIUS,
    y: 0,
    width: plotWidth + 2 * HOVER_RADIUS,
    height: PANEL_HEIGHT,
    fill: "transparent",
  });
  svg.append(hits);
  const wrapper = html("div", { class: "panel-wrap" }, [svg]);
  const show = (event) => {
    const box = svg.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * PANEL_WIDTH;
    let i = 0;
    for (let j = 1; j < n; j++) {
      if (Math.abs(x(j) - px) < Math.abs(x(i) - px)) {
        i = j;
      }
    }
    cursor.setAttribute("x1", x(i));
    cursor.setAttribute("x2", x(i));
    cursor.style.display = "";
    const record = records[i];
    const milestone = milestoneFor(record.tag);
    tooltipHost.replaceChildren(
      html("div", { class: "tip-head" }, [record.tag]),
      html("div", { class: "tip-commit" }, [
        `${record.commit.slice(0, 7)} ${record.subject}`,
      ]),
      ...(milestone
        ? [html("div", { class: "tip-change" }, changeDescription(milestone))]
        : []),
      ...series.map((s) =>
        html("div", {}, [
          html("span", {
            class: "swatch",
            style: `background:${SERIES_COLORS[series.indexOf(s)]}`,
          }),
          `${s.label}: ${format(s.values[i], unit)}`,
        ]),
      ),
    );
    tooltipHost.hidden = false;
    const hostBox = wrapper.getBoundingClientRect();
    const left = event.clientX - hostBox.left;
    tooltipHost.style.left = `${Math.min(left + 12, hostBox.width - 240)}px`;
    tooltipHost.style.top = `${event.clientY - hostBox.top + 12}px`;
  };
  hits.addEventListener("mousemove", show);
  hits.addEventListener("mouseleave", () => {
    cursor.style.display = "none";
    tooltipHost.hidden = true;
  });
  wrapper.append(tooltipHost);
  return wrapper;
}

// 0..max stretched to a round number the gridlines divide evenly.
function niceCeiling(max) {
  const magnitude = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 4, 5, 10]) {
    if (step * magnitude >= max) {
      return step * magnitude;
    }
  }
  return 10 * magnitude;
}

function axisLabel(value) {
  if (value === 0) {
    return "0";
  }
  return value >= 100
    ? value.toFixed(0)
    : value >= 10
      ? +value.toFixed(1)
      : +value.toFixed(2);
}

// A table with one row per release, so every plotted value is readable
// without hovering.
function table(records, columns) {
  const head = html("tr", {}, [
    html("th", {}, ["engine"]),
    html("th", {}, ["change"]),
    ...columns.map((c) => html("th", {}, [c.label])),
  ]);
  const rows = records.map((record) => {
    const milestone = milestoneFor(record.tag);
    return html("tr", {}, [
      html("td", {}, [tagLink(record.tag)]),
      html(
        "td",
        { class: "change" },
        milestone
          ? changeDescription(milestone)
          : [html("span", { class: "muted" }, [record.subject])],
      ),
      ...columns.map((c) =>
        html("td", { class: "num" }, [
          c.cell ? c.cell(record) : format(c.value(record), c.unit),
        ]),
      ),
    ]);
  });
  return html("details", { class: "table" }, [
    html("summary", {}, ["Table"]),
    html("div", { class: "scroll" }, [
      html("table", {}, [html("thead", {}, [head]), html("tbody", {}, rows)]),
    ]),
  ]);
}

function drawExec(records) {
  const host = document.getElementById("exec-charts");
  const withExec = records.filter((r) => r.exec?.results);
  if (withExec.length === 0) {
    host.append(html("p", { class: "muted" }, ["No exec-bench records yet."]));
    return;
  }
  const grid = html("div", { class: "grid" });
  const columns = [];
  for (const name of PACKAGES) {
    const series = ["cold", "warm"].map((phase) => ({
      label: phase,
      values: withExec.map((r) => wall(r, name, phase)),
    }));
    const command =
      withExec.map((r) => execResult(r, name)?.command).find((c) => c) ?? "";
    grid.append(
      panel(
        name,
        command,
        withExec,
        series,
        "s",
        html("div", { class: "tip", hidden: "" }),
      ),
    );
    for (const phase of ["cold", "warm"]) {
      columns.push({
        label: `${name} ${phase}`,
        unit: "s",
        value: (r) => wall(r, name, phase),
        cell: (r) => wallCell(r, name, phase),
      });
    }
  }
  grid.append(
    panel(
      "boot",
      "median over the suite's fresh guests",
      withExec,
      [{ label: "boot", values: withExec.map(bootSeconds) }],
      "s",
      html("div", { class: "tip", hidden: "" }),
    ),
  );
  columns.push({ label: "boot", unit: "s", value: bootSeconds });
  host.append(grid, table(withExec, columns));
}

function drawEmubench(records) {
  const host = document.getElementById("emubench-charts");
  const withRows = records.filter((r) => r.emubench?.rows);
  if (withRows.length === 0) {
    host.append(html("p", { class: "muted" }, ["No emubench records yet."]));
    return;
  }
  const grid = html("div", { class: "grid" });
  for (const [name, what] of CLASSES) {
    grid.append(
      panel(
        name,
        what,
        withRows,
        [{ label: "mips", values: withRows.map((r) => mips(r, name)) }],
        "mips",
        html("div", { class: "tip", hidden: "" }),
      ),
    );
  }
  const every = [];
  for (const record of withRows) {
    for (const name of Object.keys(record.emubench.rows)) {
      if (!every.includes(name)) {
        every.push(name);
      }
    }
  }
  const columns = every.map((name) => ({
    label: name,
    unit: "mips",
    value: (r) => mips(r, name),
    cell: (r) => mipsCell(r, name),
  }));
  columns.push({
    label: "guest clock / host clock",
    unit: "",
    value: (r) =>
      typeof r.emubench.clock_ratio === "number"
        ? r.emubench.clock_ratio.toFixed(2)
        : null,
  });
  host.append(grid, table(withRows, columns));
}

function describeRunner(records) {
  const latest = [...records].reverse().find((r) => r.runner);
  if (!latest) {
    return;
  }
  const { runner } = latest;
  const measured = records.filter((r) => !r.error && !r.unmeasured);
  const probeRuns = latest.emubench?.runs;
  const facts = [
    [
      "method",
      `every instruction-class point is the median of ${probeRuns ?? "several"} probe runs; every package point is one run, cold then warm, in a fresh guest`,
    ],
    ["CPU", `${runner.cpu}, ${runner.cores} hardware threads`],
    [
      "latest run placement",
      runner.cpu_affinity
        ? `CPUs ${runner.cpu_affinity.join(", ")}; NUMA memory node ${runner.memory_node}`
        : null,
    ],
    ["latest run notes", latest.notes],
    [
      "memory",
      typeof runner.memory_gib === "number" ? `${runner.memory_gib} GiB` : null,
    ],
    ["kernel", `Linux ${runner.kernel}`],
    ["browser", runner.browser],
    ["probe", latest.probe ? latest.probe.split("/").pop() : null],
  ];
  const list = document.getElementById("appendix");
  for (const [term, value] of facts) {
    if (value === null || value === undefined) {
      continue;
    }
    list.append(html("dt", {}, [term]), html("dd", {}, [value]));
  }

  const host = document.getElementById("appendix-skipped");
  const unbuilt = records.filter((r) => r.error);
  if (unbuilt.length > 0) {
    host.append(
      html("p", {}, [
        `${unbuilt.length} pinned engines could not be rebuilt: `,
        unbuilt.map((r) => `${r.commit.slice(0, 7)} (${r.subject})`).join("; "),
        ". Releases before guest/machine.json existed cannot be driven by today's page either.",
      ]),
    );
  }
  const unmeasured = records.filter((r) => r.unmeasured);
  for (const reason of new Set(unmeasured.map((r) => r.unmeasured))) {
    const these = unmeasured.filter((r) => r.unmeasured === reason);
    host.append(
      html("p", {}, [
        `${these.length} releases carry no numbers, ${these[0].tag} to ${these[these.length - 1].tag}: ${reason}`,
      ]),
    );
  }
}

// A store path's name and version, the way nixpkgs splits them: the
// version starts at the first dash that a digit follows.
function nameAndVersion(storePath) {
  const name = storePath.slice("/nix/store/".length + 33);
  const match = /^(.+?)-(\d.*)$/.exec(name);
  return match
    ? { name: match[1], version: match[2] }
    : { name, version: null };
}

// The package a suite entry ran, as the newest record that recorded it
// resolved it, linked so the boot page picks exactly that version.
function packageLink(records, name) {
  const spec =
    execResult(records[records.length - 1], name)?.spec ?? `pkg=${name}`;
  const resolved = [...records]
    .reverse()
    .map((r) => execResult(r, name)?.resolved)
    .find((path) => typeof path === "string");
  if (!resolved) {
    return html("a", { href: `../?${spec}` }, [name]);
  }
  const { version } = nameAndVersion(resolved);
  if (spec.startsWith("pkg=") && version) {
    const attr = spec.slice("pkg=".length);
    return html(
      "a",
      {
        href: `../?pkg=${encodeURIComponent(`${attr}@${version}`)}`,
        title: resolved,
      },
      [`${attr} ${version}`],
    );
  }
  return html(
    "a",
    { href: `../?path=${encodeURIComponent(resolved)}`, title: resolved },
    [resolved.slice("/nix/store/".length + 33)],
  );
}

// The whole suite, oldest measured engine against the latest, cold and warm.
function standings(records) {
  const withExec = records.filter((r) => r.exec?.results);
  if (withExec.length < 2) {
    return;
  }
  const last = withExec[withExec.length - 1];
  const head = html("tr", {}, [
    html("th", {}, ["package"]),
    html("th", {}, ["command"]),
    html("th", {}, ["cold, oldest"]),
    html("th", {}, ["cold, latest"]),
    html("th", {}, ["speedup"]),
    html("th", {}, ["warm, oldest"]),
    html("th", {}, ["warm, latest"]),
    html("th", {}, ["speedup"]),
  ]);
  const ratio = (a, b) =>
    a !== null && b !== null && b > 0 ? `${(a / b).toFixed(1)}x` : "–";
  const rows = PACKAGES.map((name) => {
    const cells = [
      html("td", {}, [packageLink(withExec, name)]),
      html("td", {}, [
        html("code", {}, [execResult(last, name)?.command ?? ""]),
      ]),
    ];
    for (const phase of ["cold", "warm"]) {
      // oldest: the first record in which the command ran at all
      const earliest = withExec.find((r) => wall(r, name, phase) !== null);
      const before = earliest ? wall(earliest, name, phase) : null;
      const after = wall(last, name, phase);
      cells.push(
        html("td", { class: "num" }, [format(before, "s")]),
        html("td", { class: "num" }, [format(after, "s")]),
        html("td", { class: "num" }, [ratio(before, after)]),
      );
    }
    return html("tr", {}, cells);
  });
  document
    .getElementById("standings")
    .append(
      html("div", { class: "scroll" }, [
        html("table", { class: "prose" }, [
          html("thead", {}, [head]),
          html("tbody", {}, rows),
        ]),
      ]),
    );
}

// Every link into the repository is written against main, and rewritten
// here to the commit of the latest engine measured, so the patches and
// documents the page links are the ones that produced the numbers on it.
function pinLinks(records) {
  const latest = [...records].reverse().find((r) => r.commit && !r.error);
  if (!latest) {
    return;
  }
  for (const anchor of document.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href");
    for (const kind of ["blob", "tree"]) {
      const prefix = `${REPO_URL}${kind}/main/`;
      if (href.startsWith(prefix)) {
        anchor.setAttribute(
          "href",
          `${REPO_URL}${kind}/${latest.commit}/${href.slice(prefix.length)}`,
        );
      }
    }
  }
}

async function main() {
  // no-store: the file changes with every deploy and carries no hash
  const response = await fetch(HISTORY_URL, { cache: "no-store" });
  const history = await response.json();
  const records = history.records ?? [];
  drawExec(records);
  drawEmubench(records);
  standings(records);
  describeRunner(records);
  pinLinks(records);
}

main().catch((error) => {
  document.getElementById("exec-charts").textContent =
    `could not load ${HISTORY_URL}: ${error}`;
});
