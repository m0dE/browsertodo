/**
 * When a page that is loading can be used: after DOMContentLoaded, once what
 * it shows has stopped changing for a moment. Heavy web apps (Gmail and the
 * like) keep loading resources for seconds after they can be read and
 * clicked, so the load event is not waited for; a page that is complete only
 * needs one unchanged reading. Both drivers use it after a navigation, each
 * reading the page its own way (the debugger, or chrome.scripting).
 */
import type { Sleep } from "@browsertodo/shared";
import { NAV_TIMEOUT_MS, POLL_MS } from "./driver-common.js";

/** One reading of a page: which document it is, how far it loaded, and how much it shows. */
export interface LoadProbe {
  /** performance.timeOrigin: a new document has a new one. */
  doc: number;
  state: DocumentReadyState;
  /** Links, buttons and fields. */
  controls: number;
  /** Characters of text. */
  text: number;
  /** Another extension's frame is on the page (Chrome then refuses the debugger for the tab). */
  foreignFrame: boolean;
}

/** The reading, in the page. Self-contained: serialized by the debugger and chrome.scripting. */
export function loadProbeInPage(): LoadProbe {
  const controls = document.querySelectorAll("a[href],button,input,select,textarea,[role=button],[role=link],[role=tab],[contenteditable=true]").length;
  const foreignFrame = document.querySelector('iframe[src^="chrome-extension://"]') !== null;
  return { doc: performance.timeOrigin, state: document.readyState, controls, text: document.body?.textContent?.length ?? 0, foreignFrame };
}

/**
 * The id of another extension whose frame is in the page (the first found), or null. Chrome refuses
 * the debugger for the tab because of it. Self-contained: run with chrome.scripting.
 */
export function foreignExtensionInPage(): string | null {
  const frame = document.querySelector<HTMLIFrameElement>('iframe[src^="chrome-extension://"]');
  return (frame && /^chrome-extension:\/\/([a-p]{32})\//.exec(frame.src)?.[1]) || null;
}

/** Unchanged readings in a row that make a page usable: complete, or only past DOMContentLoaded (still loading resources). */
export const STABLE_READINGS = { complete: 1, interactive: 3 } as const;

/**
 * Waits until the page is usable (see the file comment). read: one reading,
 * or null when the page cannot be read right now (it is navigating); an
 * error it throws ends the wait. leaving: the document being navigated away
 * from (its readings are not the new page). Resolves with the last reading
 * once usable, or null after timeoutMs.
 */
export async function waitForUsablePage(
  read: () => Promise<LoadProbe | null>,
  opts: { sleep: Sleep; leaving?: number | null; timeoutMs?: number },
): Promise<LoadProbe | null> {
  const deadline = Date.now() + (opts.timeoutMs ?? NAV_TIMEOUT_MS);
  let last: string | null = null;
  let same = 0;
  for (;;) {
    const p = await read();
    if (p && p.doc !== opts.leaving && p.state !== "loading") {
      // Text in 200-character steps: a clock or a counter ticking does not keep the page "changing".
      const key = `${p.controls}|${Math.round(p.text / 200)}`;
      same = key === last ? same + 1 : 0;
      last = key;
      const needed = p.state === "complete" ? STABLE_READINGS.complete : STABLE_READINGS.interactive;
      if (same >= needed && (p.controls > 0 || p.state === "complete")) return p;
    } else {
      last = null;
      same = 0;
    }
    if (Date.now() >= deadline) return null;
    await opts.sleep(POLL_MS);
  }
}

/**
 * The document a navigation from `from` to `to` leaves, or null when it
 * stays in the same document (only the #fragment changes), so its readings
 * count.
 */
export function leavingDocument(from: string | undefined, to: string, doc: number | null | undefined): number | null {
  if (doc == null) return null;
  const strip = (u: string) => u.replace(/#.*$/, "");
  return from && to.includes("#") && strip(from) === strip(to) ? null : doc;
}
