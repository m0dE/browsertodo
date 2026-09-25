/**
 * The run log of a task session (runs/<session>-<stamp>/log.jsonl), for the
 * side panel's "Raw log" link. Only files inside the runs folder are served.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { relative, resolve, isAbsolute } from "node:path";

/** Default and largest tail sent to the extension (native messages are capped at 1 MB). */
export const RUN_LOG_MAX_BYTES = 256 * 1024;

export function readRunLog(runsDir: string, path: string, maxBytes = RUN_LOG_MAX_BYTES): { text: string; truncated: boolean } {
  const full = resolve(path);
  const rel = relative(resolve(runsDir), full);
  if (!path || rel.startsWith("..") || isAbsolute(rel)) throw new Error("not a browsertodo run log");
  const limit = Math.max(1, Math.min(RUN_LOG_MAX_BYTES, Math.trunc(maxBytes) || RUN_LOG_MAX_BYTES));
  const fd = openSync(full, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - limit);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    // Start at a whole line when the head was cut.
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return { text, truncated: start > 0 };
  } finally {
    closeSync(fd);
  }
}
