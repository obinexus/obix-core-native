# Native provider model

## `.node` ≠ `.dll` / `.so` / `.dylib`

A Node-API addon (`.node`) is loaded with `require`/`createRequire` and exposes
JS functions directly. A raw shared library is machine code with a C ABI — using
it needs a **real FFI provider or bridge** (Bun `dlopen`, Node's flag-gated
`node:ffi`, or a compiled shim). This package models both as *provider kinds*; it
never treats a `.dll` as if it were a `.node`.

```
kind: "node-api"                -> require(".node")
kind: "ffi-bun"                 -> requires Bun + Bun.dlopen
kind: "ffi-node-experimental"   -> requires runtime === "node" + the ffi capability
kind: "bridge"                  -> a caller-supplied load() that returns a NativeModule
```

## Selection, then loading — never the other way round

`select(operation, host?)` matches, in order: runtime → OS → arch → libc/ABI →
kind-specific capability. It returns a `SelectResult` with a precise
`CompatError` code on failure:

| code | cause |
|------|-------|
| `native/no-provider` | nothing implements the op, or wrong runtime/OS |
| `native/arch-mismatch` | a provider exists but not for `host.arch` |
| `native/abi-mismatch` | libc / ABI (e.g. musl vs glibc) does not match |
| `native/denied` | the runtime's permission model forbids native addons |

`list()` and `select()` **never call `load()`**. `probeNative()` — used by
`obix doctor` — only reports selectability and always sets
`executionTested: false`.

## Lazy load, managed handle

`open(id)` is the *only* method that calls `spec.load()`. It happens on an
explicit `open`, not on import and not during doctor inspection. The returned
`NativeHandle`:

- `call(op, …args)` — `native/no-provider` for an unknown op,
- `close()` — idempotent; runs the module's `close`/`dispose` if present,
- `call` after `close` → `native/disposed`.

A loader that throws `ENOENT` → `native/no-binary`; any other throw →
`native/failure`.

## What "native compatibility" requires

Registry + selection + lifecycle are tested. **Execution is not.** Qualifying a
native call means: a real provider, a compiled addon fixture, and a build
toolchain, all on the exact runtime / OS / arch / libc. A fake provider whose
`load()` returns a plain object exercises the machinery but proves nothing about
native support.
