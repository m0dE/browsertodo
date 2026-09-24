/**
 * Writes task media to real files with chrome.downloads, so both brains and
 * DOM.setFileInputFiles get absolute local paths:
 * Downloads/browsertodo-media/<sessionId>/<name>.
 *
 * Local blobs go through a data: URL (URL.createObjectURL does not exist in
 * an MV3 service worker; data: URL downloads were checked to work up to at
 * least 60 MB). Cloud media is downloaded straight from the API with the
 * runner key as a header, falling back to fetch + data: URL.
 */

export type MediaSource =
  | { kind: "blob"; name: string; blob: Blob }
  | { kind: "url"; name: string; url: string; headers?: { name: string; value: string }[] };

export interface MaterializedMedia {
  paths: string[];
  /** Deletes the files and erases them from the download history. Never throws. */
  cleanup(): Promise<void>;
}

type DownloadDelta = { id: number; state?: { current?: string }; error?: { current?: string } };

/** The subset of chrome.downloads used here. */
export interface DownloadsLike {
  download(options: {
    url: string;
    filename?: string;
    conflictAction?: "uniquify" | "overwrite" | "prompt";
    saveAs?: boolean;
    headers?: { name: string; value: string }[];
  }): Promise<number>;
  search(query: { id: number }): Promise<{ id: number; state?: string; filename: string; error?: string }[]>;
  onChanged: { addListener(fn: (d: DownloadDelta) => void): void; removeListener(fn: (d: DownloadDelta) => void): void };
  setUiOptions?(options: { enabled: boolean }): Promise<void>;
  removeFile(id: number): Promise<void>;
  erase(query: { id: number }): Promise<number[]>;
}

export const MEDIA_DIR = "browsertodo-media";

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
};

/** A file name that is safe on Windows and inside the downloads folder. */
export function safeFileName(name: string, type = ""): string {
  let n = (name.split(/[\\/]/).pop() ?? "")
    .replace(/[<>:"|?*\u0000-\u001f]/g, "_")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = `_${n}`;
  if (!n) n = "file";
  if (!/\.[a-z0-9]{1,8}$/i.test(n)) n += EXT_BY_TYPE[type.split(";")[0]!.trim().toLowerCase()] ?? "";
  if (n.length > 120) {
    const ext = /\.[a-z0-9]{1,8}$/i.exec(n)?.[0] ?? "";
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n;
}

/** Makes names unique within one batch: a.png, a-2.png, ... */
export function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.map((n) => {
    let out = n;
    const dot = n.lastIndexOf(".");
    const stem = dot > 0 ? n.slice(0, dot) : n;
    const ext = dot > 0 ? n.slice(dot) : "";
    for (let i = 2; seen.has(out.toLowerCase()); i++) out = `${stem}-${i}${ext}`;
    seen.add(out.toLowerCase());
    return out;
  });
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(bin)}`;
}

export class MediaFiles {
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: { downloads?: DownloadsLike; timeoutMs?: number; fetch?: typeof fetch } = {}) {
    this.timeoutMs = opts.timeoutMs ?? 5 * 60_000;
    this.fetchFn = opts.fetch ?? ((i, init) => fetch(i, init));
  }

  private get downloads(): DownloadsLike {
    return this.opts.downloads ?? (chrome.downloads as unknown as DownloadsLike);
  }

  async materialize(sessionId: string, sources: MediaSource[]): Promise<MaterializedMedia> {
    const ids: number[] = [];
    const cleanup = async () => {
      for (const id of ids) {
        await this.downloads.removeFile(id).catch(() => {});
        await this.downloads.erase({ id }).catch(() => {});
      }
    };
    if (sources.length === 0) return { paths: [], cleanup };
    const dir = `${MEDIA_DIR}/${safeFileName(sessionId)}`;
    const names = uniqueNames(sources.map((s) => safeFileName(s.name, s.kind === "blob" ? s.blob.type : "")));
    const paths: string[] = [];
    await this.downloads.setUiOptions?.({ enabled: false }).catch(() => {});
    try {
      for (const [i, src] of sources.entries()) {
        const filename = `${dir}/${names[i]}`;
        let path: string;
        if (src.kind === "blob") {
          path = await this.write({ url: await blobToDataUrl(src.blob), filename }, ids);
        } else {
          try {
            path = await this.write({ url: src.url, filename, headers: src.headers }, ids);
          } catch (err) {
            // Some servers or header combinations fail inside the download manager; fetch it ourselves.
            const res = await this.fetchFn(src.url, { headers: Object.fromEntries((src.headers ?? []).map((h) => [h.name, h.value])) });
            if (!res.ok) throw new Error(`Downloading ${src.name} failed: HTTP ${res.status} (${errText(err)})`);
            path = await this.write({ url: await blobToDataUrl(await res.blob()), filename }, ids);
          }
        }
        paths.push(path);
      }
    } catch (err) {
      await cleanup();
      throw err;
    } finally {
      await this.downloads.setUiOptions?.({ enabled: true }).catch(() => {});
    }
    return { paths, cleanup };
  }

  /** One download; resolves with the absolute path once complete. */
  private async write(
    opts: { url: string; filename: string; headers?: { name: string; value: string }[] },
    ids: number[],
  ): Promise<string> {
    const dl = this.downloads;
    const finished = new Map<number, DownloadDelta>();
    let wake: (() => void) | null = null;
    const listener = (d: DownloadDelta) => {
      if (d.state?.current && d.state.current !== "in_progress") {
        finished.set(d.id, d);
        wake?.();
      }
    };
    dl.onChanged.addListener(listener);
    try {
      const id = await dl.download({
        url: opts.url,
        filename: opts.filename,
        conflictAction: "uniquify",
        saveAs: false,
        ...(opts.headers?.length ? { headers: opts.headers } : {}),
      });
      ids.push(id);
      const deadline = Date.now() + this.timeoutMs;
      for (;;) {
        const [item] = await dl.search({ id });
        if (item?.state === "complete") {
          if (!item.filename) throw new Error(`Download of ${opts.filename} finished without a file path`);
          return item.filename;
        }
        if (item?.state === "interrupted" || !item) {
          throw new Error(`Writing ${opts.filename} failed: ${item?.error ?? finished.get(id)?.error?.current ?? "download interrupted"}`);
        }
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`Writing ${opts.filename} timed out`);
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, Math.min(left, 1000));
          wake = () => {
            clearTimeout(t);
            resolve();
          };
          if (finished.has(id)) wake();
        });
        wake = null;
      }
    } finally {
      dl.onChanged.removeListener(listener);
    }
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
