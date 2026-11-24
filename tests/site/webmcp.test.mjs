// Tests the descriptions of the tools site/js/webmcp.js declares. An
// agent picks a tool and reads its answer by its description, so a
// description has to name the guest this page boots, which depends on
// the engine (engine.js). Each test builds the tools for each engine
// with a stand-in page, whose operations the descriptions never call,
// and reads the descriptions.
import { test } from "node:test";
import assert from "node:assert/strict";

import { Engine, systemOf } from "../../site/js/engine.js";
import { toolsFor } from "../../site/js/webmcp.js";

const PAGE = {};

// The engine whose machine a page on `engine` does not boot.
const OTHER_ENGINE = Object.freeze({
  [Engine.UNKERNEL]: Engine.QEMU,
  [Engine.QEMU]: Engine.UNKERNEL,
});

// A system's architecture, as the descriptions name a machine.
const architectureOf = (engine) => systemOf(engine).split("-")[0];

// The description of the tool `name`, as a page on `engine` declares it.
function described(engine, name) {
  return toolsFor(PAGE, engine).find((tool) => tool.name === name).description;
}

for (const engine of Object.values(Engine)) {
  // Checks that the boot tool names the system of the guest it boots.
  test(`the boot tool names the ${engine} engine's system`, () => {
    assert.match(described(engine, "boot"), new RegExp(systemOf(engine)));
  });

  // Checks that list-versions names the system a version has to be
  // built for to boot here, which is the system the page resolves
  // packages for.
  test(`list-versions names the ${engine} engine's system`, () => {
    assert.match(
      described(engine, "list-versions"),
      new RegExp(systemOf(engine)),
    );
  });

  // Checks that no tool names the other engine's machine, as every
  // description once said x86_64 whatever the engine.
  test(`no tool on ${engine} names the other engine's machine`, () => {
    const other = architectureOf(OTHER_ENGINE[engine]);
    for (const tool of toolsFor(PAGE, engine)) {
      assert.doesNotMatch(tool.description, new RegExp(other), tool.name);
    }
  });
}
