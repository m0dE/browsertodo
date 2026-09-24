/**
 * RpcPeer's `MethodMap` constraint is `Record<string, ...>`, which the shared
 * method *interfaces* do not satisfy (interfaces have no implicit index
 * signature). Re-mapping them to anonymous object types fixes that without
 * changing their members.
 */
import type { BrowserMethods, HelperMethods, PipeMethods } from "@browsertodo/shared";

export type MethodMapOf<T> = { [K in keyof T]: T[K] };
export type BrowserMap = MethodMapOf<BrowserMethods>;
export type HelperMap = MethodMapOf<HelperMethods>;
export type PipeMap = MethodMapOf<PipeMethods>;
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type NoMethods = {};
