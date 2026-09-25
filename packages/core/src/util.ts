/** Small helpers shared by the core modules. Browser- and Node-safe. */

export const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Collapse whitespace and lowercase, for loose text comparison. */
export function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}
