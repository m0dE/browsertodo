/**
 * Hand-written fake of the parts of the `chrome` API the extension uses.
 * `installChromeFake()` puts a fresh one on globalThis.chrome and returns it.
 */

type Listener<A extends unknown[]> = (...args: A) => unknown;

export class FakeEvent<A extends unknown[]> {
  readonly listeners: Listener<A>[] = [];
  addListener(fn: Listener<A>): void {
    this.listeners.push(fn);
  }
  removeListener(fn: Listener<A>): void {
    const i = this.listeners.indexOf(fn);
    if (i >= 0) this.listeners.splice(i, 1);
  }
  hasListener(fn: Listener<A>): boolean {
    return this.listeners.includes(fn);
  }
  emit(...args: A): unknown[] {
    return this.listeners.map((fn) => fn(...args));
  }
}

type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>;

export class FakeStorageArea {
  data: Record<string, unknown> = {};
  constructor(
    private readonly areaName: string,
    private readonly onChanged: FakeEvent<[Changes, string]>,
  ) {}
  async get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
    if (keys == null) return clone(this.data);
    const list = Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const k of list) if (k in this.data) out[k] = clone(this.data[k]);
    return out;
  }
  async set(items: Record<string, unknown>): Promise<void> {
    const changes: Changes = {};
    for (const [k, v] of Object.entries(items)) {
      changes[k] = { oldValue: this.data[k], newValue: clone(v) };
      this.data[k] = clone(v);
    }
    this.onChanged.emit(changes, this.areaName);
  }
  async remove(keys: string | string[]): Promise<void> {
    const changes: Changes = {};
    for (const k of Array.isArray(keys) ? keys : [keys]) {
      if (k in this.data) changes[k] = { oldValue: this.data[k] };
      delete this.data[k];
    }
    this.onChanged.emit(changes, this.areaName);
  }
}

export interface FakeAlarm {
  name: string;
  periodInMinutes?: number;
  scheduledTime: number;
}

export interface FakePort {
  name: string;
  posted: unknown[];
  postMessage(msg: unknown): void;
  disconnect(): void;
  onMessage: FakeEvent<[unknown]>;
  onDisconnect: FakeEvent<[FakePort]>;
  /** Test helper: simulate the host sending a message. */
  deliver(msg: unknown): void;
  /** Test helper: simulate the host closing the port. */
  hostDisconnect(error?: string): void;
}

export interface FakeTab {
  id: number;
  windowId: number;
  url: string;
  active: boolean;
}

export interface FakeDownload {
  id: number;
  url: string;
  filename: string;
  headers?: { name: string; value: string }[];
  state: "in_progress" | "complete" | "interrupted";
  error?: string;
  removed: boolean;
  erased: boolean;
}

export function installChromeFake() {
  const onChanged = new FakeEvent<[Changes, string]>();
  let nextTabId = 100;
  let nextWindowId = 10;

  const fake = {
    runtime: {
      id: "testextensionid",
      lastError: undefined as { message: string } | undefined,
      getURL: (p: string) => `chrome-extension://testextensionid/${p.replace(/^\//, "")}`,
      ports: [] as FakePort[],
      onMessage: new FakeEvent<unknown[]>(),
      onConnect: new FakeEvent<unknown[]>(),
      platformInfoCalls: 0,
      async getPlatformInfo() {
        fake.runtime.platformInfoCalls++;
        return { os: "win", arch: "x86-64", nacl_arch: "x86-64" };
      },
      onInstalled: new FakeEvent<unknown[]>(),
      onStartup: new FakeEvent<unknown[]>(),
      /** Called for every new native port; tests use it to script the host. */
      onConnectNative: undefined as ((port: FakePort) => void) | undefined,
      connectNative(name: string): FakePort {
        const port: FakePort = {
          name,
          posted: [],
          onMessage: new FakeEvent(),
          onDisconnect: new FakeEvent(),
          postMessage(msg) {
            port.posted.push(msg);
          },
          disconnect() {
            /* a client-side disconnect does not fire onDisconnect in Chrome */
          },
          deliver(msg) {
            port.onMessage.emit(msg);
          },
          hostDisconnect(error) {
            fake.runtime.lastError = error ? { message: error } : undefined;
            port.onDisconnect.emit(port);
            fake.runtime.lastError = undefined;
          },
        };
        fake.runtime.ports.push(port);
        fake.runtime.onConnectNative?.(port);
        return port;
      },
    },
    storage: {
      onChanged,
      local: new FakeStorageArea("local", onChanged),
      session: new FakeStorageArea("session", onChanged),
    },
    alarms: {
      all: new Map<string, FakeAlarm>(),
      async create(name: string, info: { periodInMinutes?: number; delayInMinutes?: number; when?: number }) {
        fake.alarms.all.set(name, {
          name,
          periodInMinutes: info.periodInMinutes,
          scheduledTime: info.when ?? Date.now() + (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60_000,
        });
      },
      async get(name: string) {
        return fake.alarms.all.get(name);
      },
      async clear(name: string) {
        return fake.alarms.all.delete(name);
      },
      onAlarm: new FakeEvent<[FakeAlarm]>(),
    },
    notifications: {
      created: [] as { id?: string; options: Record<string, unknown> }[],
      async create(idOrOptions: unknown, options?: unknown) {
        if (typeof idOrOptions === "string") {
          fake.notifications.created.push({ id: idOrOptions, options: options as Record<string, unknown> });
          return idOrOptions;
        }
        fake.notifications.created.push({ options: idOrOptions as Record<string, unknown> });
        return `n${fake.notifications.created.length}`;
      },
    },
    tabs: {
      byId: new Map<number, FakeTab>(),
      async get(id: number) {
        const t = fake.tabs.byId.get(id);
        if (!t) throw new Error(`No tab with id: ${id}.`);
        return { ...t };
      },
      onUpdated: new FakeEvent<unknown[]>(),
    },
    windows: {
      byId: new Map<number, { id: number; tabs: FakeTab[] }>(),
      createCalls: [] as Record<string, unknown>[],
      async create(opts: Record<string, unknown>) {
        fake.windows.createCalls.push(opts);
        const id = nextWindowId++;
        const tab: FakeTab = { id: nextTabId++, windowId: id, url: String(opts.url ?? "about:blank"), active: true };
        fake.tabs.byId.set(tab.id, tab);
        fake.windows.byId.set(id, { id, tabs: [tab] });
        return { id, tabs: [{ ...tab }] };
      },
      async get(id: number, _opts?: unknown) {
        const w = fake.windows.byId.get(id);
        if (!w) throw new Error(`No window with id: ${id}.`);
        return { id: w.id, tabs: w.tabs.map((t) => ({ ...t })) };
      },
      async remove(id: number) {
        const w = fake.windows.byId.get(id);
        if (!w) throw new Error(`No window with id: ${id}.`);
        for (const t of w.tabs) fake.tabs.byId.delete(t.id);
        fake.windows.byId.delete(id);
      },
      onRemoved: new FakeEvent<unknown[]>(),
    },
    debugger: {
      attached: new Set<number>(),
      commands: [] as { tabId: number; method: string; params?: unknown }[],
      /** Test hook deciding each command's result. */
      respond: ((_method: string, _params: unknown): unknown => ({})) as (method: string, params: any) => unknown,
      async attach(target: { tabId: number }, _version: string) {
        if (fake.debugger.attached.has(target.tabId)) {
          throw new Error(`Another debugger is already attached to the tab with id: ${target.tabId}.`);
        }
        fake.debugger.attached.add(target.tabId);
      },
      async detach(target: { tabId: number }) {
        fake.debugger.attached.delete(target.tabId);
      },
      async sendCommand(target: { tabId: number }, method: string, params?: unknown) {
        if (!fake.debugger.attached.has(target.tabId)) {
          throw new Error(`Debugger is not attached to the tab with id: ${target.tabId}.`);
        }
        fake.debugger.commands.push({ tabId: target.tabId, method, params });
        return fake.debugger.respond(method, params);
      },
      onDetach: new FakeEvent<[{ tabId?: number }, string]>(),
      onEvent: new FakeEvent<unknown[]>(),
    },
    action: { onClicked: new FakeEvent<unknown[]>() },
    sidePanel: {
      behavior: null as unknown,
      async setPanelBehavior(b: unknown) {
        fake.sidePanel.behavior = b;
      },
    },
    downloads: {
      items: [] as FakeDownload[],
      uiEnabled: true,
      /** Every setUiOptions call, in order. */
      uiCalls: [] as boolean[],
      /** Download directory used for absolute paths. */
      dir: "C:\\Users\\me\\Downloads",
      /** Test hook: how a new download ends. Default: completes on the next tick. */
      behavior: ((_d: FakeDownload): "complete" | "interrupted" | "hang" => "complete") as (d: FakeDownload) => "complete" | "interrupted" | "hang",
      onChanged: new FakeEvent<[{ id: number; state?: { current?: string }; error?: { current?: string } }]>(),
      async download(opts: { url: string; filename?: string; headers?: { name: string; value: string }[] }) {
        const id = fake.downloads.items.length + 1;
        const rel = (opts.filename ?? "download").replace(/\//g, "\\");
        const d: FakeDownload = { id, url: opts.url, filename: "", headers: opts.headers, state: "in_progress", removed: false, erased: false };
        fake.downloads.items.push(d);
        const how = fake.downloads.behavior(d);
        if (how !== "hang") {
          setTimeout(() => {
            if (how === "complete") {
              d.state = "complete";
              d.filename = `${fake.downloads.dir}\\${rel}`;
            } else {
              d.state = "interrupted";
              d.error = "SERVER_FORBIDDEN";
            }
            fake.downloads.onChanged.emit({ id, state: { current: d.state } });
          }, 0);
        }
        return id;
      },
      async search(q: { id: number }) {
        const d = fake.downloads.items.find((x) => x.id === q.id && !x.erased);
        return d ? [{ id: d.id, state: d.state, filename: d.filename, error: d.error }] : [];
      },
      async setUiOptions(o: { enabled: boolean }) {
        fake.downloads.uiEnabled = o.enabled;
        fake.downloads.uiCalls.push(o.enabled);
      },
      async removeFile(id: number) {
        const d = fake.downloads.items.find((x) => x.id === id);
        if (d) d.removed = true;
      },
      async erase(q: { id: number }) {
        const d = fake.downloads.items.find((x) => x.id === q.id);
        if (d) d.erased = true;
        return d ? [d.id] : [];
      },
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = fake;
  return fake;
}

export type ChromeFake = ReturnType<typeof installChromeFake>;

function clone<T>(v: T): T {
  return v === undefined ? v : structuredClone(v);
}
