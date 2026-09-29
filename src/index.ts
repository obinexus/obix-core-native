/**
 * obix-core-native
 *
 * A TypeScript native-provider **registry**: provider declaration, host / OS /
 * arch / libc / ABI selection, lazy loading and managed handles.
 *
 * This package is authored entirely in TS/JS. It does not contain a native
 * binary, a bridge, or any invented native-bridge API.
 * It never loads native code on import or during ordinary `doctor` inspection —
 * only an explicit `open()` triggers a provider's `load()`.
 *
 * A `.node` addon and a raw `.dll` / `.so` / `.dylib` are different things: a
 * raw shared library needs a real FFI provider or bridge to be registered.
 * Experimental FFI (Bun `dlopen`, Node's flag-gated `node:ffi`) is an explicit
 * provider choice, never a default.
 */
import {
  CompatError,
  detectHost,
  probeCapabilities,
  type HostRecord,
  type RuntimeName,
} from "obix-core-capabilities";

export { CompatError, detectHost } from "obix-core-capabilities";
export type { HostRecord, RuntimeName } from "obix-core-capabilities";

export type NativeKind = "node-api" | "ffi-bun" | "ffi-node-experimental" | "bridge";
export type Libc = "glibc" | "musl";
export type Ownership = "caller-frees" | "provider-managed";

export interface NativeAbi {
  /** Minimum Node-API version the provider needs (`node-api` kind). */
  napiVersion?: number;
  /** For `ffi-*` kinds: which experimental FFI it relies on. */
  ffi?: "bun" | "node-experimental";
}

export interface NativeModule {
  /** `operation -> impl`. The registry calls these; it never generates them. */
  [operation: string]: (...args: unknown[]) => unknown;
}

export interface NativeProviderSpec {
  id: string;
  kind: NativeKind;
  /** Runtimes this provider supports. */
  runtime: RuntimeName[];
  /** `process.platform`-style values. */
  os: string[];
  arch: string[];
  /** Required libc on Linux. Omit when irrelevant. */
  libc?: Libc[];
  abi?: NativeAbi;
  /** Operation names the provider implements. */
  operations: string[];
  ownership: Ownership;
  /**
   * Lazy loader. Called ONLY by `open()`. Must return a `NativeModule` or throw.
   * A file-not-found should throw an error whose message contains "ENOENT".
   */
  load: () => Promise<NativeModule> | NativeModule;
  /** Optional human note (path, provenance). */
  detail?: string;
}

export interface ProviderInfo {
  id: string;
  kind: NativeKind;
  runtime: RuntimeName[];
  os: string[];
  arch: string[];
  libc: Libc[] | null;
  abi: NativeAbi | null;
  operations: string[];
  ownership: Ownership;
  detail: string | null;
}

export type SelectFailure =
  | "native/no-provider"
  | "native/arch-mismatch"
  | "native/abi-mismatch"
  | "native/denied";

export interface SelectResult {
  ok: boolean;
  provider?: NativeProviderSpec;
  error?: CompatError;
}

export interface NativeHandle {
  readonly providerId: string;
  readonly ownership: Ownership;
  readonly closed: boolean;
  /** Invoke an operation. Throws `native/disposed` after `close()`, `native/no-provider` for an unknown op. */
  call<T = unknown>(operation: string, ...args: unknown[]): Promise<T>;
  /** Idempotent. */
  close(): Promise<void>;
}

export interface NativeRegistryAPI {
  register(spec: NativeProviderSpec): void;
  /** Metadata for every registered provider — **without loading any of them**. */
  list(): ProviderInfo[];
  /** Choose a provider for `operation` on `host` (default: this host). */
  select(operation: string, host?: HostRecord): SelectResult;
  /** Lazily `load()` a provider and return a managed handle. */
  open(providerId: string, opts?: { signal?: AbortSignal }): Promise<NativeHandle>;
  /** True when this provider *would* be selectable here — no load, no execution. */
  isSelectableHere(providerId: string): boolean;
}

function fail(code: CompatError["code"], operation: string, reason: string, remediation?: string): CompatError {
  return new CompatError({ code, package: "obix-core-native", operation, reason, remediation });
}

function toInfo(s: NativeProviderSpec): ProviderInfo {
  return {
    id: s.id,
    kind: s.kind,
    runtime: [...s.runtime],
    os: [...s.os],
    arch: [...s.arch],
    libc: s.libc ? [...s.libc] : null,
    abi: s.abi ?? null,
    operations: [...s.operations],
    ownership: s.ownership,
    detail: s.detail ?? null,
  };
}

export function createNativeRegistry(): NativeRegistryAPI {
  const providers = new Map<string, NativeProviderSpec>();

  function assertSpec(spec: NativeProviderSpec): void {
    for (const k of ["id", "kind", "ownership"] as const) {
      if (typeof spec[k] !== "string") throw fail("native/no-provider", "register", `provider.${k} must be a string`);
    }
    for (const k of ["runtime", "os", "arch", "operations"] as const) {
      if (!Array.isArray(spec[k]) || spec[k].length === 0)
        throw fail("native/no-provider", "register", `provider.${k} must be a non-empty array`);
    }
    if (typeof spec.load !== "function") throw fail("native/no-provider", "register", "provider.load must be a function");
  }

  function matchFailure(spec: NativeProviderSpec, host: HostRecord): SelectFailure | null {
    if (!spec.runtime.includes(host.runtime)) return "native/no-provider";
    if (host.os && !spec.os.includes(host.os)) return "native/no-provider";
    if (host.arch && !spec.arch.includes(host.arch)) return "native/arch-mismatch";
    if (spec.libc && host.libc && !spec.libc.includes(host.libc)) return "native/abi-mismatch";

    if (spec.kind === "node-api") {
      const cap = probeCapabilities(["native-addon"])["native-addon"];
      if (cap.status === "denied") return "native/denied";
      if (cap.status === "unavailable") return "native/no-provider";
      // napiVersion is compared by the loaded module in practice; the registry
      // cannot verify it without loading. Recorded, not enforced here.
    } else if (spec.kind === "ffi-bun") {
      if (host.runtime !== "bun" || typeof (globalThis as { Bun?: { dlopen?: unknown } }).Bun?.dlopen !== "function")
        return "native/no-provider";
    } else if (spec.kind === "ffi-node-experimental") {
      if (host.runtime !== "node") return "native/no-provider";
      const cap = probeCapabilities(["ffi"])["ffi"];
      if (cap.status !== "available") return "native/no-provider";
    }
    return null;
  }

  return {
    register(spec) {
      assertSpec(spec);
      if (providers.has(spec.id)) throw fail("native/no-provider", "register", `provider id "${spec.id}" is already registered`);
      providers.set(spec.id, spec);
    },

    list() {
      return [...providers.values()].map(toInfo);
    },

    select(operation, host = detectHost()) {
      const candidates = [...providers.values()].filter((p) => p.operations.includes(operation));
      if (candidates.length === 0) {
        return {
          ok: false,
          error: fail("native/no-provider", "select", `no provider implements "${operation}"`, "Register a provider whose `operations` includes it."),
        };
      }
      let lastFailure: SelectFailure = "native/no-provider";
      for (const spec of candidates) {
        const f = matchFailure(spec, host);
        if (f == null) return { ok: true, provider: spec };
        lastFailure = f;
      }
      const reason =
        lastFailure === "native/arch-mismatch"
          ? `a provider for "${operation}" exists but not for arch ${host.arch}`
          : lastFailure === "native/abi-mismatch"
            ? `a provider for "${operation}" exists but its libc/ABI does not match this host`
            : lastFailure === "native/denied"
              ? `a provider for "${operation}" exists but native addons are denied by the runtime's permission model`
              : `a provider for "${operation}" exists but not for this runtime/OS`;
      return { ok: false, error: fail(lastFailure, "select", reason) };
    },

    isSelectableHere(providerId) {
      const spec = providers.get(providerId);
      if (!spec) return false;
      return matchFailure(spec, detectHost()) == null;
    },

    async open(providerId, opts = {}) {
      const spec = providers.get(providerId);
      if (!spec) throw fail("native/no-provider", "open", `no provider registered with id "${providerId}"`);
      const f = matchFailure(spec, detectHost());
      if (f != null) {
        throw fail(
          f,
          "open",
          `provider "${providerId}" is not usable on this host (${f.replace("native/", "")})`,
          f === "native/denied" ? "Grant the runtime's native-addon / FFI permission and retry." : undefined,
        );
      }
      if (opts.signal?.aborted) throw fail("native/failure", "open", "aborted before load");

      let mod: NativeModule;
      try {
        mod = await spec.load();
      } catch (err) {
        const e = err as { message?: string; code?: string };
        const enoent = e?.code === "ENOENT" || /ENOENT|not found|cannot find/i.test(e?.message ?? "");
        throw fail(
          enoent ? "native/no-binary" : "native/failure",
          "open",
          enoent
            ? `provider "${providerId}" binary not found: ${e?.message ?? String(err)}`
            : `provider "${providerId}" failed to load: ${e?.message ?? String(err)}`,
          enoent ? "Install / build the native binary for this platform, or use a different provider." : undefined,
        );
      }

      let closed = false;
      return {
        providerId,
        ownership: spec.ownership,
        get closed() {
          return closed;
        },
        async call<T>(operation: string, ...args: unknown[]): Promise<T> {
          if (closed) throw fail("native/disposed", "call", `handle for "${providerId}" is closed`);
          const fn = mod[operation];
          if (typeof fn !== "function") {
            throw fail("native/no-provider", "call", `provider "${providerId}" has no operation "${operation}"`);
          }
          try {
            return (await fn(...args)) as T;
          } catch (err) {
            throw fail("native/failure", "call", `"${operation}" threw: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
        async close() {
          if (closed) return;
          closed = true;
          const disposer = mod["close"] ?? mod["dispose"];
          if (typeof disposer === "function") {
            try {
              await disposer();
            } catch {
              /* provider cleanup best-effort */
            }
          }
        },
      };
    },
  };
}

// ── doctor ──────────────────────────────────────────────────────────────────

export interface NativeReadiness {
  /** operation -> { selectable: boolean, providerId?: string, reason: string } */
  operations: Record<string, { selectable: boolean; providerId?: string; reason: string }>;
  /** Execution is never proven by inspection alone. */
  executionTested: false;
  note: string;
}

/** Report which operations have a selectable provider on this host — no load, no run. */
export function probeNative(registry: NativeRegistryAPI, operations: readonly string[]): NativeReadiness {
  const out: NativeReadiness["operations"] = {};
  for (const op of operations) {
    const r = registry.select(op);
    out[op] = r.ok
      ? { selectable: true, providerId: r.provider!.id, reason: `provider ${r.provider!.id} matches this host` }
      : { selectable: false, reason: r.error?.reason ?? "no provider" };
  }
  return {
    operations: out,
    executionTested: false,
    note: "A selectable provider is not proof of a working native call. Native execution must be qualified by a real provider + fixture on the exact runtime/OS/arch/libc.",
  };
}
