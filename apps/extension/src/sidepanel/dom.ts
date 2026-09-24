/** Tiny DOM helpers (no framework). */

type Attrs = Record<string, string | number | boolean | undefined | null | EventListener>;
type Child = Node | string | null | undefined | false;

/** h("div.row.muted", { title: "x", onclick: fn }, "text", child) */
export function h<K extends keyof HTMLElementTagNameMap>(
  tagAndClasses: K | `${K}.${string}`,
  attrs: Attrs | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const [tag, ...classes] = tagAndClasses.split(".") as [K, ...string[]];
  const el = document.createElement(tag);
  if (classes.length) el.className = classes.join(" ");
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = [el.className, String(v)].filter(Boolean).join(" ");
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Show a short message in a status element; clears itself after `ms` when tone is ok. */
export function flash(el: HTMLElement, text: string, tone: "ok" | "bad" | "" = "", ms = 4000): void {
  el.textContent = text;
  el.dataset.tone = tone;
  if (tone === "ok" && text) {
    const stamp = String(Date.now());
    el.dataset.stamp = stamp;
    setTimeout(() => {
      if (el.dataset.stamp === stamp) el.textContent = "";
    }, ms);
  }
}

/** Run an async button action with the button disabled meanwhile. */
export async function busy<T>(button: HTMLButtonElement, fn: () => Promise<T>): Promise<T> {
  button.disabled = true;
  try {
    return await fn();
  } finally {
    button.disabled = false;
  }
}
