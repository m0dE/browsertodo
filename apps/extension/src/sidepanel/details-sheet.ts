/**
 * The task details sheet: a modal <dialog> over the side panel with
 * everything known about a task or a chat message (see task-details.ts for
 * the model). Closed by its Close button, Esc or a click on the backdrop;
 * focus then goes back to what opened it.
 */
import type { SessionInfo } from "@browsertodo/shared";
import { uiRequest } from "../ui-protocol.js";
import { h } from "./dom.js";
import { detailsModel, linkParts, type DetailsInput, type DetailsModel, type DetailsTask } from "./task-details.js";

export interface SheetOptions {
  /** "Open in TODO" (shown when the model has a TODO entry). */
  onOpenInTodo?(taskId: string): void;
}

/** The instructions with their line breaks, and http(s) links that open in a new tab. */
export function renderText(text: string): HTMLElement {
  return h(
    "div.sheet-text",
    null,
    ...linkParts(text).map((p) => ("url" in p ? h("a", { href: p.url, target: "_blank", rel: "noopener noreferrer" }, p.url) : p.text)),
  );
}

async function copyText(text: string, host: HTMLElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older Chrome or no clipboard permission: the selection way (inside the dialog, which is the only live part).
    const area = h("textarea", { "aria-hidden": "true", tabindex: "-1", style: "position:fixed;opacity:0;pointer-events:none" });
    area.value = text;
    host.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

let current: HTMLDialogElement | null = null;

/** Where focus goes when the sheet closes: the trigger, or its replacement if the list re-rendered meanwhile. */
function returnFocus(trigger: HTMLElement | null): void {
  if (!trigger) return;
  const id = trigger.dataset.taskId;
  const target = trigger.isConnected ? trigger : id ? document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`) : null;
  target?.focus();
}

export function openDetails(model: DetailsModel, trigger: HTMLElement | null, opts: SheetOptions = {}): HTMLDialogElement {
  current?.close();
  let back: HTMLElement | null = trigger;

  const msg = h("span.msg", { role: "status" });
  const copyBtn = h("button.ghost.small", { type: "button", disabled: !model.text }, "Copy instructions");
  const todoId = model.todoId;
  const todoBtn = todoId && opts.onOpenInTodo ? h("button.ghost.small", { type: "button", title: "Show this task in the TODO tab" }, "Open in TODO") : null;
  const closeBtn = h("button.ghost.small", { type: "button" }, "Close");

  const rows: HTMLElement[] = [];
  if (model.chip) rows.push(h("dt", null, "Status"), h("dd", null, h("span.chip", { "data-tone": model.chip.tone, title: model.chip.hint || null }, model.chip.label)));
  for (const f of model.fields) {
    const value = f.href ? h("a", { href: f.href, target: "_blank", rel: "noopener noreferrer", title: f.href }, f.value) : f.value;
    rows.push(h("dt", null, f.label), h("dd", { class: [f.mono ? "mono" : "", f.tone ? `tone-${f.tone}` : ""].filter(Boolean).join(" ") || null }, value));
  }

  const dialog = h(
    "dialog.sheet",
    { "aria-labelledby": "sheet-title" },
    h(
      "div.sheet-in",
      null,
      h("div.sheet-head", null, h("h2", { id: "sheet-title" }, model.heading), h("span.spacer"), closeBtn),
      h(
        "div.sheet-body",
        null,
        h("div.sheet-label", null, model.textLabel),
        model.text ? renderText(model.text) : h("p.sheet-note", null, "No instructions were saved."),
        model.textNote ? h("p.sheet-note", null, model.textNote) : null,
        rows.length ? h("dl.sheet-fields", null, ...rows) : null,
        model.files.length
          ? h(
              "div.sheet-files",
              null,
              h("div.sheet-label", null, "Files"),
              h("ul.files", null, ...model.files.map((f) => h("li", { title: [f.name, f.detail].filter(Boolean).join(" · ") }, h("span", null, f.name), f.detail ? h("span.file-detail", null, f.detail) : null))),
            )
          : null,
      ),
      h("div.sheet-actions", null, copyBtn, todoBtn, msg),
    ),
  );

  closeBtn.addEventListener("click", () => dialog.close());
  // A click on the backdrop lands on the dialog itself (its content fills it).
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (current === dialog) current = null;
    returnFocus(back);
  });
  copyBtn.addEventListener("click", () => {
    void copyText(model.text, dialog).then((ok) => {
      msg.textContent = ok ? "Copied." : "Could not copy. Select the text and copy it instead.";
      msg.dataset.tone = ok ? "ok" : "bad";
    });
  });
  todoBtn?.addEventListener("click", () => {
    // Focus goes to the task in the TODO tab, not back to the trigger.
    back = null;
    dialog.close();
    opts.onOpenInTodo?.(todoId!);
  });

  document.body.append(dialog);
  current = dialog;
  dialog.showModal();
  closeBtn.focus();
  return dialog;
}

/** Closes the sheet if one is open. */
export function closeDetails(): void {
  current?.close();
}

/**
 * Everything known about a run's task (its TODO entry, when the list has it)
 * or a TODO entry's runs (the latest one), for the sheet. Lookups are best
 * effort: what could not be loaded is left out.
 */
export async function gatherDetails(from: { session: SessionInfo } | { task: DetailsTask; listSource: "local" | "account" }): Promise<DetailsInput> {
  if ("task" in from) {
    try {
      const { sessions } = await uiRequest({ type: "sessions.list", limit: 200 });
      // Newest first: the first run of this task is its latest.
      const session = sessions.find((s) => s.taskId === from.task.id) ?? null;
      return { ...from, session };
    } catch {
      return from;
    }
  }
  const s = from.session;
  if (s.source === "adhoc" || !s.taskId) return { session: s };
  try {
    const list = await uiRequest({ type: "tasks.list" });
    const task = list.tasks.find((t) => t.id === s.taskId) ?? null;
    return { session: s, task, listSource: list.source ?? "local" };
  } catch {
    return { session: s };
  }
}

/** Gathers what is known, then opens the sheet. */
export async function showDetails(
  from: Parameters<typeof gatherDetails>[0],
  trigger: HTMLElement | null,
  opts: SheetOptions = {},
): Promise<void> {
  const input = await gatherDetails(from);
  openDetails(detailsModel(input), trigger, opts);
}
