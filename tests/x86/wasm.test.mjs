// Tests the WebAssembly binary encoder by building small modules with it
// and running them under the host's own WebAssembly engine: a module that
// adds, a module with an import and a mutable global, and a pair of
// functions that tail-call each other ten million times at constant
// stack, which is the property the translator's block chaining rests on.
import { test } from "node:test";
import assert from "node:assert/strict";

import { Code, ModuleBuilder, T } from "../../site/js/x86/wasm.js";

test("a function that adds two i64s", async () => {
  const m = new ModuleBuilder();
  const type = m.addType([T.i64, T.i64], [T.i64]);
  const c = new Code();
  c.local_get(0).local_get(1).i64_add().end();
  m.addFunc(type, [], c, { export: "add" });
  const { instance } = await WebAssembly.instantiate(m.toBytes());
  assert.equal(instance.exports.add(40n, 2n), 42n);
});

test("imports, mutable globals and locals", async () => {
  const m = new ModuleBuilder();
  const rax = new WebAssembly.Global({ value: "i64", mutable: true }, 0n);
  m.importGlobal("env", "rax", T.i64, true);
  const cb = m.importFunc("env", "cb", m.addType([T.i32], []));
  const c = new Code();
  c.declareLocal(T.i64);
  c.global_get(0).i64_const(5).i64_add().local_tee(0).global_set(0);
  c.local_get(0).i32_wrap_i64().call(cb).end();
  m.addFunc(m.addType([], []), c.locals, c, { export: "bump" });
  const seen = [];
  const { instance } = await WebAssembly.instantiate(m.toBytes(), {
    env: { rax, cb: (v) => seen.push(v) },
  });
  rax.value = 37n;
  instance.exports.bump();
  assert.equal(rax.value, 42n);
  assert.deepEqual(seen, [42]);
});

test("tail calls through an imported table run at constant stack", async () => {
  const m = new ModuleBuilder();
  const counter = new WebAssembly.Global({ value: "i32", mutable: true }, 0);
  m.importGlobal("env", "n", T.i32, true);
  const table = new WebAssembly.Table({ element: "anyfunc", initial: 8 });
  m.importTable("env", "table", { min: 8 });
  const unit = m.addType([], []);
  // f0: if n == 0 return; n -= 1; return_call_indirect table[1]
  const c0 = new Code();
  c0.global_get(0).i32_eqz().if_(T.empty).return_().end();
  c0.global_get(0).i32_const(1).i32_sub().global_set(0);
  c0.i32_const(1).return_call_indirect(unit, 0).end();
  const f0 = m.addFunc(unit, [], c0);
  // f1: return_call f0
  const c1 = new Code();
  c1.return_call(f0).end();
  const f1 = m.addFunc(unit, [], c1);
  m.addElem(0, 0, [f0, f1]);
  const { instance } = await WebAssembly.instantiate(m.toBytes(), {
    env: { n: counter, table },
  });
  counter.value = 10_000_000;
  table.get(0)();
  assert.equal(counter.value, 0);
  assert.ok(instance);
});

test("a branch table and a loop", async () => {
  const m = new ModuleBuilder();
  const type = m.addType([T.i32], [T.i32]);
  // sum = 0; do { sum += case(i % 3); i--; } while (i != 0)
  // where case 0 adds 10, case 1 adds 100 and the default adds 1000.
  const c = new Code(1);
  const sum = c.declareLocal(T.i32);
  c.loop(T.empty);
  c.block(T.empty).block(T.empty).block(T.empty).block(T.empty);
  c.local_get(0).i32_const(3).i32_rem_u().br_table([0, 1], 2);
  c.end().i32_const(10).local_get(sum).i32_add().local_set(sum).br(2);
  c.end().i32_const(100).local_get(sum).i32_add().local_set(sum).br(1);
  c.end().i32_const(1000).local_get(sum).i32_add().local_set(sum);
  c.end();
  c.local_get(0).i32_const(1).i32_sub().local_tee(0).br_if(0);
  c.end();
  c.local_get(sum).end();
  m.addFunc(type, c.locals, c, { export: "f" });
  const { instance } = await WebAssembly.instantiate(m.toBytes());
  // i=3 -> 10, i=2 -> 1000, i=1 -> 100
  assert.equal(instance.exports.f(3), 1110);
});
