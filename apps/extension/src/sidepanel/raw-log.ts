/** "Raw log": the helper's own record of every Claude Code stream event of a session, in a new tab. */
import { uiRequest } from "../ui-protocol.js";

/** Call from the click itself: the tab opens before the first await so the browser allows it. */
export async function openRawLog(sessionId: string): Promise<void> {
  const win = window.open("", "_blank");
  try {
    const res = await uiRequest({ type: "session.log", sessionId });
    const head = `${res.path}${res.truncated ? "\n(only the last part of the log is shown)" : ""}\n\n`;
    const url = URL.createObjectURL(new Blob([head + res.text], { type: "text/plain;charset=utf-8" }));
    if (win) win.location.href = url;
    else window.open(url, "_blank");
  } catch (err) {
    win?.close();
    throw err;
  }
}
