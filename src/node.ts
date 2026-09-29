/**
 * obix-core-native/node
 *
 * Node helpers for building providers: load a `.node` Node-API addon.
 * Importing this touches `node:module`; it does NOT load any native code.
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { extname } from "node:path";
import { CompatError } from "obix-core-capabilities";
import type { NativeModule, NativeProviderSpec, Ownership } from "./index.js";

export interface NodeApiProviderOptions {
  id: string;
  /** Absolute path to a `.node` addon. */
  addonPath: string;
  operations: string[];
  os?: string[];
  arch?: string[];
  libc?: ("glibc" | "musl")[];
  napiVersion?: number;
  ownership?: Ownership;
  /** Map an operation name to a method on the loaded addon. Default: identity. */
  bind?: (addon: Record<string, unknown>) => NativeModule;
  detail?: string;
}

/**
 * Build a `node-api` provider spec that loads a `.node` addon **lazily** (only
 * when the registry `open()`s it). A raw `.dll` / `.so` / `.dylib` is rejected —
 * that needs an FFI provider, not this.
 */
export function nodeApiProvider(o: NodeApiProviderOptions): NativeProviderSpec {
  const ext = extname(o.addonPath).toLowerCase();
  if (ext !== ".node") {
    throw new CompatError({
      code: "native/no-binary",
      package: "obix-core-native",
      operation: "nodeApiProvider",
      reason: `addonPath must be a .node addon, got "${ext}" — a .dll/.so/.dylib needs an FFI provider`,
      remediation: "Point at a compiled Node-API .node addon, or register an ffi-* / bridge provider.",
    });
  }
  return {
    id: o.id,
    kind: "node-api",
    runtime: ["node"],
    os: o.os ?? [process.platform],
    arch: o.arch ?? [process.arch],
    libc: o.libc,
    abi: { napiVersion: o.napiVersion },
    operations: [...o.operations],
    ownership: o.ownership ?? "provider-managed",
    detail: o.detail ?? o.addonPath,
    load: () => {
      if (!existsSync(o.addonPath)) {
        const e = new Error(`ENOENT: no such addon ${o.addonPath}`) as Error & { code?: string };
        e.code = "ENOENT";
        throw e;
      }
      const req = createRequire(import.meta.url);
      const addon = req(o.addonPath) as Record<string, unknown>;
      return o.bind ? o.bind(addon) : (addon as NativeModule);
    },
  };
}

export { createNativeRegistry, probeNative } from "./index.js";
export type { NativeRegistryAPI, NativeProviderSpec, NativeHandle } from "./index.js";
