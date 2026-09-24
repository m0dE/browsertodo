/** Downloads a claimed task's media from the API into the run's media folder. */
import { createWriteStream, mkdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { MediaInfo } from "@browsertodo/shared";

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** A safe Windows filename that keeps the original extension. */
export function sanitizeFilename(name: string, fallback: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "").trim();
  // extname(".png") is "", but a bare ".png" still names the type.
  const rawExt = extname(base) || (/^\.[A-Za-z0-9]+$/.test(base) ? base : "");
  const ext = rawExt.replace(/[^A-Za-z0-9.]/g, "").slice(0, 10);
  let stem = base.slice(0, base.length - rawExt.length);
  stem = stem.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "").replace(/^\.+/, "").slice(0, 100);
  if (!stem || RESERVED.test(stem)) stem = `${fallback.replace(/[^A-Za-z0-9_-]/g, "_")}${stem ? `_${stem}` : ""}`;
  return stem + ext;
}

export async function downloadMedia(opts: {
  apiBase: string;
  runnerKey: string;
  media: MediaInfo[];
  dir: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<string[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  mkdirSync(opts.dir, { recursive: true });
  const used = new Set<string>();
  const paths: string[] = [];
  for (const m of opts.media) {
    let name = sanitizeFilename(m.filename, m.id);
    if (used.has(name.toLowerCase())) {
      const ext = extname(name);
      name = `${name.slice(0, name.length - ext.length)}-${m.id.replace(/[^A-Za-z0-9_-]/g, "_")}${ext}`;
    }
    used.add(name.toLowerCase());
    const url = `${opts.apiBase.replace(/\/+$/, "")}/v1/media/${encodeURIComponent(m.id)}`;
    const init: RequestInit = { headers: { Authorization: `Bearer ${opts.runnerKey}` } };
    if (opts.signal) init.signal = opts.signal;
    const res = await doFetch(url, init);
    if (!res.ok || !res.body) {
      throw new Error(`media ${m.id} download failed: HTTP ${res.status}`);
    }
    const path = resolve(join(opts.dir, name));
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(path));
    paths.push(path);
  }
  return paths;
}
