import {
  pauseReasonForUrl,
  pickDelayMs,
  type ClaimResponse,
  type ExtensionSettings,
  type HelperInfo,
  type HelperMethods,
  type MediaInfo,
  type ResultInput,
  type RunConfig,
  type Screenshot,
  type TaskRunResult,
} from "@browsertodo/shared";

export const HEARTBEAT_MS = 2 * 60_000;
/** Extra wait after abortTask before giving up on the helper. */
const ABORT_GRACE_MS = 30_000;

export interface RunState {
  running: boolean;
  currentTaskId: string | null;
  lastRunAt: string | null;
  lastError: string | null;
}

export interface CoordinatorApi {
  claim(runnerId: string): Promise<ClaimResponse | null>;
  heartbeat(taskId: string, runnerId: string): Promise<unknown>;
  result(taskId: string, body: ResultInput): Promise<void>;
  uploadMedia(blob: Blob, filename: string): Promise<MediaInfo>;
}

export interface CoordinatorHelper {
  connect(timeoutMs?: number): Promise<HelperInfo>;
  call<M extends keyof HelperMethods & string>(
    method: M,
    params: HelperMethods[M]["params"],
    opts?: { timeoutMs?: number },
  ): Promise<HelperMethods[M]["result"]>;
  onDisconnect(fn: (reason: string) => void): () => void;
}

export interface CoordinatorDeps {
  loadSettings(): Promise<ExtensionSettings>;
  getRunnerId(): Promise<string>;
  createApi(settings: ExtensionSettings): CoordinatorApi;
  helper: CoordinatorHelper;
  /** Ensure the agent window and tab exist and the debugger is attached. */
  prepareTab(): Promise<void>;
  isAgentTab(tabId: number): Promise<boolean>;
  screenshot(): Promise<Screenshot>;
  notify(title: string, message: string): void | Promise<void>;
  saveState(patch: Partial<RunState>): Promise<void>;
  sleep?(ms: number): Promise<void>;
  now?(): Date;
  log?(message: string): void;
}

interface ActiveTask {
  taskId: string;
  forcedPause: string | null;
}

class HelperGone extends Error {}

/** The run loop: claim, run through the helper, report, pace. */
export class Coordinator {
  private active: ActiveTask | null = null;
  private isRunning = false;

  constructor(private readonly deps: CoordinatorDeps) {}

  get running(): boolean {
    return this.isRunning;
  }

  get currentTaskId(): string | null {
    return this.active?.taskId ?? null;
  }

  async run(trigger: "alarm" | "manual"): Promise<void> {
    if (this.isRunning) {
      this.log(`run (${trigger}) skipped: already running`);
      return;
    }
    this.isRunning = true;
    try {
      const settings = await this.deps.loadSettings();
      if (settings.paused && trigger === "alarm") {
        this.log("run skipped: paused");
        return;
      }
      if (!settings.apiBase || !settings.runnerKey) {
        await this.deps.saveState({ lastError: "API base URL and runner key are not set. Open the options page." });
        return;
      }
      await this.deps.saveState({ running: true, currentTaskId: null, lastRunAt: this.now().toISOString(), lastError: null });
      await this.loop(settings);
    } catch (err) {
      await this.deps.saveState({ lastError: message(err) });
    } finally {
      this.active = null;
      this.isRunning = false;
      await this.deps.saveState({ running: false, currentTaskId: null });
    }
  }

  /** chrome.tabs.onUpdated: pause the task when the agent tab hits a pause URL. */
  async onTabUpdated(tabId: number, changeInfo: { url?: string }): Promise<void> {
    const active = this.active;
    if (!active || !changeInfo.url || active.forcedPause) return;
    const reason = pauseReasonForUrl(changeInfo.url);
    if (!reason || !(await this.deps.isAgentTab(tabId))) return;
    active.forcedPause = reason;
    this.log(`forcing pause of ${active.taskId}: ${reason}`);
    await this.deps.helper.call("helper.forcePause", { taskId: active.taskId, reason }).catch((err) => this.log(`forcePause failed: ${message(err)}`));
  }

  /** The user closed the debugger infobar: stop the task. */
  async onDebuggerCanceled(): Promise<void> {
    const active = this.active;
    if (!active) return;
    await this.deps.helper
      .call("helper.abortTask", { taskId: active.taskId, reason: "debugger detached by user" })
      .catch((err) => this.log(`abortTask failed: ${message(err)}`));
  }

  private async loop(initial: ExtensionSettings): Promise<void> {
    try {
      await this.deps.helper.connect(10_000);
    } catch (err) {
      const msg = message(err);
      await this.deps.saveState({ lastError: `Helper not connected: ${msg}` });
      await this.deps.notify("Helper not connected", `Install and register the browsertodo helper. ${msg}`);
      return;
    }
    const runnerId = await this.deps.getRunnerId();
    let settings = initial;
    for (;;) {
      const api = this.deps.createApi(settings);
      const claim = await api.claim(runnerId);
      if (!claim) return;
      const result = await this.runOne(api, claim, settings, runnerId);
      if (result.outcome === "paused") {
        await this.deps.notify("Task paused", result.reason ?? "The task needs your attention.");
        return;
      }
      if (result.helperGone) {
        await this.deps.saveState({ lastError: "Run stopped: helper disconnected" });
        return;
      }
      await this.sleep(pickDelayMs(settings));
      settings = await this.deps.loadSettings();
      if (settings.paused) return;
    }
  }

  private async runOne(
    api: CoordinatorApi,
    claim: ClaimResponse,
    settings: ExtensionSettings,
    runnerId: string,
  ): Promise<TaskRunResult & { helperGone?: boolean }> {
    const taskId = claim.task.id;
    const active: ActiveTask = { taskId, forcedPause: null };
    this.active = active;
    await this.deps.saveState({ currentTaskId: taskId });
    this.log(`task ${taskId} claimed`);

    const heartbeat = setInterval(() => {
      api.heartbeat(taskId, runnerId).catch((err) => this.log(`heartbeat failed: ${message(err)}`));
    }, HEARTBEAT_MS);
    const cleanups: (() => void)[] = [() => clearInterval(heartbeat)];

    let result: TaskRunResult;
    let helperGone = false;
    try {
      await this.deps.prepareTab();
      const config: RunConfig = {
        apiBase: settings.apiBase,
        runnerKey: settings.runnerKey,
        maxToolCalls: settings.maxToolCalls,
        maxTaskMinutes: settings.maxTaskMinutes,
        jevEnabled: settings.jevEnabled,
        jevThreshold: settings.jevThreshold,
      };
      const disconnected = new Promise<never>((_, reject) => {
        cleanups.push(this.deps.helper.onDisconnect(() => reject(new HelperGone("helper disconnected"))));
      });
      const safetyMinutes = settings.maxTaskMinutes + 2;
      const safety = new Promise<never>((_, reject) => {
        const reason = `no result after ${safetyMinutes} minutes`;
        const t1 = setTimeout(() => {
          this.deps.helper.call("helper.abortTask", { taskId, reason }).catch(() => {});
          const t2 = setTimeout(() => reject(new Error(reason)), ABORT_GRACE_MS);
          cleanups.push(() => clearTimeout(t2));
        }, safetyMinutes * 60_000);
        cleanups.push(() => clearTimeout(t1));
      });
      disconnected.catch(() => {});
      safety.catch(() => {});
      result = await Promise.race([this.deps.helper.call("helper.runTask", { claim, config }), disconnected, safety]);
    } catch (err) {
      helperGone = err instanceof HelperGone;
      result = { outcome: "failed", reason: message(err) };
    } finally {
      for (const fn of cleanups) fn();
    }
    if (active.forcedPause) result = { outcome: "paused", reason: active.forcedPause, logPath: result.logPath };

    const screenshotId = await this.uploadScreenshot(api, taskId);
    const body: ResultInput = { runnerId, outcome: result.outcome, retryAfterMinutes: settings.pauseRetryMinutes };
    if (result.summary) body.summary = result.summary.slice(0, 4000);
    if (result.url) body.url = result.url.slice(0, 2000);
    if (result.reason) body.reason = result.reason.slice(0, 4000);
    if (screenshotId) body.screenshotId = screenshotId;
    await api.result(taskId, body);
    this.log(`task ${taskId} ${result.outcome}${result.reason ? `: ${result.reason}` : ""}`);
    this.active = null;
    await this.deps.saveState({ currentTaskId: null });
    return { ...result, helperGone };
  }

  private async uploadScreenshot(api: CoordinatorApi, taskId: string): Promise<string | undefined> {
    try {
      const shot = await this.deps.screenshot();
      const bytes = Uint8Array.from(atob(shot.base64), (c) => c.charCodeAt(0));
      const ext = shot.mimeType === "image/png" ? "png" : "jpg";
      const info = await api.uploadMedia(new Blob([bytes], { type: shot.mimeType }), `result-${taskId}.${ext}`);
      return info.id;
    } catch (err) {
      this.log(`final screenshot skipped: ${message(err)}`);
      return undefined;
    }
  }

  private sleep(ms: number): Promise<void> {
    if (this.deps.sleep) return this.deps.sleep(ms);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private log(msg: string): void {
    this.deps.log?.(msg);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
