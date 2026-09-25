/** "Raw log": the helper's own record of every Claude Code stream event of a session, in a new tab. */
import type { SessionInfo } from "@browsertodo/shared";
import { uiRequest } from "../ui-protocol.js";
import { busy } from "../ui/dom.js";

/** The log's tab has read it well before this; then its blob URL is released. */
const LOG_URL_LIFETIME_MS = 60_000;

/** Call from the click itself: the tab opens before the first await so the browser allows it. */
export async function openRawLog(sessionId: string): Promise<void> {
  const win = window.open("", "_blank");
  try {
    const res = await uiRequest({ type: "session.log", sessionId });
    const head = `${res.path}${res.truncated ? "\n(only the last part of the log is shown)" : ""}\n\n`;
    const url = URL.createObjectURL(new Blob([head + res.text], { type: "text/plain;charset=utf-8" }));
    if (win) win.location.href = url;
    else window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), LOG_URL_LIFETIME_MS);
  } catch (err) {
    win?.close();
    throw err;
  }
}

/** A Raw log button: opens the log of `session()` when the button can be used; says why it failed with `onError`. */
export function wireRawLog(button: HTMLButtonElement, session: () => SessionInfo | null, onError: (message: string) => void): void {
  button.addEventListener("click", () => {
    const s = session();
    if (!s || button.disabled || button.getAttribute("aria-disabled") === "true") return;
    void busy(button, () => openRawLog(s.sessionId), (message) => onError(`Raw log: ${message}`));
  });
}
