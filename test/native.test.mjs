import test from "node:test";
import assert from "node:assert/strict";
import { createNativeRegistry, probeNative, CompatError, detectHost } from "../dist/index.js";
import { nodeApiProvider } from "../dist/node.js";

const HOST = detectHost();

// A REGISTRY-ONLY fake: its load() returns a plain JS object. This exercises the
// registry / selection / lifecycle machinery. It does NOT qualify native
// compatibility — see `executionTested: false` in probeNative and the repo's
// implementation-status.md.
function fakeProvider(over = {}) {
  let loads = 0;
  return {
    spec: {
      id: "fake-adder",
      kind: "node-api",
      runtime: [HOST.runtime],
      os: [HOST.os ?? process.platform],
      arch: [HOST.arch ?? process.arch],
      operations: ["add", "close"],
      ownership: "provider-managed",
      abi: { napiVersion: 8 },
      load: () => {
        loads++;
        return {
          add: (a, b) => a + b,
          close: () => {},
        };
      },
      ...over,
    },
    get loads() {
      return loads;
    },
  };
}

test("register rejects a malformed spec", () => {
  const r = createNativeRegistry();
  assert.throws(() => r.register({ id: "x" }), CompatError);
  assert.throws(() => r.register({ id: "x", kind: "node-api", ownership: "provider-managed", runtime: [], os: ["linux"], arch: ["x64"], operations: ["a"], load() {} }), CompatError);
});

test("list() returns metadata WITHOUT invoking load()", () => {
  const r = createNativeRegistry();
  const fp = fakeProvider();
  r.register(fp.spec);
  const infos = r.list();
  assert.equal(infos.length, 1);
  assert.equal(infos[0].id, "fake-adder");
  assert.deepEqual(infos[0].operations, ["add", "close"]);
  assert.equal(fp.loads, 0, "list() must not load provider code");
});

test("select() finds a host-matching provider for a known operation", () => {
  const r = createNativeRegistry();
  r.register(fakeProvider().spec);
  const sel = r.select("add");
  assert.equal(sel.ok, true);
  assert.equal(sel.provider.id, "fake-adder");
});

test("select() -> native/no-provider for an unknown operation", () => {
  const r = createNativeRegistry();
  r.register(fakeProvider().spec);
  const sel = r.select("teleport");
  assert.equal(sel.ok, false);
  assert.equal(sel.error.code, "native/no-provider");
});

test("select() -> native/arch-mismatch when a provider exists for a different arch", () => {
  const r = createNativeRegistry();
  r.register(fakeProvider({ arch: ["sparc64"] }).spec);
  const sel = r.select("add");
  assert.equal(sel.ok, false);
  assert.equal(sel.error.code, "native/arch-mismatch");
});

test("select() -> native/abi-mismatch on a libc mismatch (Linux only signal)", () => {
  const r = createNativeRegistry();
  r.register(fakeProvider({ libc: ["musl"], os: [HOST.os ?? process.platform] }).spec);
  const sel = r.select("add");
  if (HOST.libc === "glibc") {
    assert.equal(sel.error.code, "native/abi-mismatch");
  } else {
    // no libc signal on this host -> libc check is skipped, provider matches
    assert.ok(sel.ok || sel.error.code === "native/no-provider");
  }
});

test("select() -> native/no-provider for an ffi-node-experimental provider on plain Node", () => {
  const r = createNativeRegistry();
  r.register(fakeProvider({ id: "fake-ffi", kind: "ffi-node-experimental", abi: { ffi: "node-experimental" } }).spec);
  const sel = r.select("add");
  assert.equal(sel.ok, false);
  assert.equal(sel.error.code, "native/no-provider");
  assert.match(sel.error.reason, /runtime\/OS|FFI/i);
});

test("open() loads lazily, call() works, close() is idempotent, use-after-close throws native/disposed", async () => {
  const r = createNativeRegistry();
  const fp = fakeProvider();
  r.register(fp.spec);
  assert.equal(fp.loads, 0);

  const h = await r.open("fake-adder");
  assert.equal(fp.loads, 1, "open() triggers exactly one load");
  assert.equal(await h.call("add", 2, 40), 42);
  await assert.rejects(() => h.call("nope"), (e) => e instanceof CompatError && e.code === "native/no-provider");

  await h.close();
  await h.close(); // idempotent
  assert.equal(h.closed, true);
  await assert.rejects(() => h.call("add", 1, 1), (e) => e instanceof CompatError && e.code === "native/disposed");
});

test("open() a missing provider id -> native/no-provider", async () => {
  const r = createNativeRegistry();
  await assert.rejects(() => r.open("ghost"), (e) => e instanceof CompatError && e.code === "native/no-provider");
});

test("open() a provider whose load throws ENOENT -> native/no-binary", async () => {
  const r = createNativeRegistry();
  r.register(
    fakeProvider({
      id: "missing-bin",
      load: () => {
        const e = new Error("ENOENT: no such file");
        e.code = "ENOENT";
        throw e;
      },
    }).spec,
  );
  await assert.rejects(() => r.open("missing-bin"), (e) => e instanceof CompatError && e.code === "native/no-binary");
});

test("nodeApiProvider rejects a non-.node addon path", () => {
  assert.throws(
    () => nodeApiProvider({ id: "raw", addonPath: "/lib/libfoo.so", operations: ["x"] }),
    (e) => e instanceof CompatError && e.code === "native/no-binary" && /FFI provider/.test(e.reason),
  );
});

test("nodeApiProvider (runtime: node) — missing .node -> native/no-binary on Node; native/no-provider elsewhere", async () => {
  const r = createNativeRegistry();
  r.register(nodeApiProvider({ id: "abs", addonPath: process.cwd() + "/definitely-missing.node", operations: ["x"] }));
  const expected = HOST.runtime === "node" ? "native/no-binary" : "native/no-provider";
  await assert.rejects(() => r.open("abs"), (e) => e instanceof CompatError && e.code === expected);
});

test("probeNative reports selectability without loading, and never claims execution", () => {
  const r = createNativeRegistry();
  const fp = fakeProvider();
  r.register(fp.spec);
  const readiness = probeNative(r, ["add", "teleport"]);
  assert.equal(readiness.operations.add.selectable, true);
  assert.equal(readiness.operations.add.providerId, "fake-adder");
  assert.equal(readiness.operations.teleport.selectable, false);
  assert.equal(readiness.executionTested, false);
  assert.match(readiness.note, /not proof of a working native call/);
  assert.equal(fp.loads, 0);
});

test("NATIVE EXECUTION IS NOT TESTED HERE — documented prerequisite", () => {
  // There is no real N-API provider / compiled .node fixture / node-gyp
  // toolchain proven in this environment. Native execution qualification
  // requires a real provider + fixture on the exact runtime/OS/arch/libc.
  // The registry, selection and failure model above ARE tested; a fake
  // provider does not qualify native compatibility.
  assert.ok(true);
});
