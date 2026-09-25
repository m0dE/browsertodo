/**
 * Where the TODO tab's tasks live: the signed-in account (the API), or this
 * browser (the local store, used when signed out). Both answer with the
 * same row shape, so the tab's UI does not change.
 *
 * The account's list is a paid feature: on a plan without it the list comes
 * back `locked` (the kept tasks are read-only; writes answer plan_required).
 */
import type { CreateTaskInput, LocalTask, RepeatRule, Task } from "@browsertodo/shared";
import type { LocalMediaInfo, TaskPatch } from "../ui-protocol.js";
import { uploadToBlob, type LocalStore, type NewLocalTask } from "../engine/local-store.js";
import type { AccountApi, AccountTaskList } from "./account-api.js";

export type TodoRow = LocalTask & { media: LocalMediaInfo[] };

/** The list and whether it is locked (the plan does not include the TODO list: read-only until the user subscribes). */
export interface TodoList {
  tasks: TodoRow[];
  locked: boolean;
}

/**
 * A task for the account from a local task's fields (a new one, or one
 * moving in): its files are uploaded first; a repeat runs in timeZone.
 */
export async function accountTaskInput(
  api: Pick<AccountApi, "uploadMedia">,
  t: { instructions: string; account?: string | null; notBefore?: string | null; repeat?: RepeatRule | null },
  files: { name: string; blob: Blob }[],
  timeZone: string,
): Promise<CreateTaskInput> {
  const mediaIds: string[] = [];
  for (const f of files) mediaIds.push((await api.uploadMedia(f.blob, f.name)).id);
  const account = t.account?.trim();
  return {
    instructions: t.instructions,
    ...(account ? { account } : {}),
    ...(t.notBefore ? { notBefore: t.notBefore } : {}),
    ...(mediaIds.length ? { mediaIds } : {}),
    ...(t.repeat?.dailyAt.length ? { repeat: { dailyAt: t.repeat.dailyAt }, tz: timeZone } : {}),
  };
}

export interface TodoSource {
  readonly kind: "local" | "account";
  list(): Promise<TodoList>;
  add(input: NewLocalTask): Promise<LocalTask>;
  update(id: string, patch: TaskPatch): Promise<LocalTask>;
  delete(id: string): Promise<boolean>;
  retry(id: string): Promise<LocalTask>;
  cancel(id: string): Promise<LocalTask>;
}

/** An account task in the TODO row shape. Files are known by id only (the list does not carry their names). */
export function accountRow(t: Task): TodoRow {
  return {
    ...t,
    repeat: t.repeat ?? null,
    media: t.mediaIds.map((id, i) => ({ id, name: `file ${i + 1}`, type: "", size: 0 })),
  };
}

const asLocal = (t: Task): LocalTask => ({ ...t, repeat: t.repeat ?? null });

/** The signed-in account's tasks. repeat runs in the browser's IANA time zone. */
export class AccountTodo implements TodoSource {
  readonly kind = "account" as const;

  /** onChange: the list as just fetched, or nothing after a change made here. */
  constructor(
    private readonly api: AccountApi,
    private readonly timeZone: string,
    private readonly onChange: (listed?: AccountTaskList) => void = () => {},
  ) {}

  async list(): Promise<TodoList> {
    const listed = await this.api.listTasks();
    this.onChange(listed);
    return { tasks: listed.tasks.map(accountRow), locked: listed.locked };
  }

  async add(input: NewLocalTask): Promise<LocalTask> {
    const files = (input.media ?? []).map((m) => ({ name: m.name, blob: uploadToBlob(m) }));
    const task = await this.api.createTask(await accountTaskInput(this.api, input, files, this.timeZone));
    this.onChange();
    return asLocal(task);
  }

  async update(id: string, patch: TaskPatch): Promise<LocalTask> {
    const body: Record<string, unknown> = {};
    if (patch.instructions !== undefined) body.instructions = patch.instructions;
    // null (or an empty account) clears it on the server.
    if (patch.account !== undefined) body.account = patch.account?.trim() || null;
    if (patch.notBefore !== undefined) body.notBefore = patch.notBefore ?? null;
    if (patch.repeat !== undefined) {
      body.repeat = patch.repeat;
      if (patch.repeat) body.tz = this.timeZone;
    }
    const task = await this.api.updateTask(id, body);
    this.onChange();
    return asLocal(task);
  }

  async delete(id: string): Promise<boolean> {
    await this.api.deleteTask(id);
    this.onChange();
    return true;
  }

  async retry(id: string): Promise<LocalTask> {
    const task = await this.api.retryTask(id);
    this.onChange();
    return asLocal(task);
  }

  async cancel(id: string): Promise<LocalTask> {
    const task = await this.api.cancelTask(id);
    this.onChange();
    return asLocal(task);
  }
}

/**
 * This browser's tasks (signed out). The TODO tab does not show them (signed
 * out it is one Log in button, so none can be added there): they are the
 * engine's local queue, tasks kept from before the list moved into the
 * account. They run here and use no cloud storage; moving them into the
 * account is offered only on a plan with the TODO list.
 */
export class LocalTodo implements TodoSource {
  readonly kind = "local" as const;

  constructor(private readonly store: LocalStore) {}

  async list(): Promise<TodoList> {
    return { tasks: await this.store.listWithMedia(), locked: false };
  }

  add(input: NewLocalTask): Promise<LocalTask> {
    return this.store.add(input);
  }

  update(id: string, patch: TaskPatch): Promise<LocalTask> {
    return this.store.update(id, patch);
  }

  delete(id: string): Promise<boolean> {
    return this.store.delete(id);
  }

  retry(id: string): Promise<LocalTask> {
    return this.store.retry(id);
  }

  async cancel(): Promise<LocalTask> {
    // Local tasks have no cancelled state of their own: deleting is the way to drop one.
    throw new Error("Local tasks cannot be cancelled; delete it instead");
  }
}
