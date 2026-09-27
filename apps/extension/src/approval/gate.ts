/**
 * The approval gate: a BrowserCaller around an agent slot's browser that
 * holds every action that changes something until the automation level
 * allows it (automation.ts). Both brains' browser calls pass here (the Claude
 * API brain's directly, Claude Code's through the helper), so the level holds
 * whatever the model was told.
 *
 * - full: nothing waits.
 * - ask_all: every click, typing, key, upload, navigation and tab change waits; reads never do.
 * - ask_consequential: what the classifier (judge.ts) finds consequential waits.
 * - full_within_task (scheduled runs): a consequential action waits only when the task's instructions do not ask for it.
 *
 * What it knows of an action comes from the calls themselves: the last page
 * read (the element behind an index, the URL and title), and the fields typed
 * into since (the text a Post or Send click sends). It never reads the page
 * on its own: another read would renumber the elements the agent's indices
 * point at. An action that waits becomes an approval request (broker.ts); a
 * refusal is an error whose text tells the agent not to retry
 * (approvalRefusalText).
 */
import {
  APPROVAL_TIMEOUT_MS,
  approvalRefusalText,
  CONSEQUENCE_TEXT,
  isApprovalGated,
  type ApprovalGatedMethod,
  type ApprovalOutcome,
  type AgentTabInfo,
  type ApprovalRequest,
  type BrowserMethod,
  type BrowserMethods,
  type ConsequenceKind,
  type EffectiveLevel,
  type ElementInfo,
  type PageSnapshot,
} from "@browsertodo/shared";
import type { BrowserCaller } from "@browsertodo/core";
import { normalizeId } from "../agent-tab.js";
import { hostOf, type GateAction, type GateMethod, type TypedField } from "./consequence.js";
import type { SystemOneLike } from "./jev-judge.js";
import { judgeAction, judgeWithinTask } from "./judge.js";

/** What the gate needs to know about the session making a call. */
export interface GateContext {
  level: EffectiveLevel;
  /** Scheduled runs: the task's instructions (full_within_task holds actions they do not ask for). */
  instructions?: string;
  /** When the turn's time limit ends it (epoch ms): an approval waits at most until shortly before. */
  endsAt?: number;
}

export interface GateDeps {
  /** The level and task of a session, looked up at each action (a changed setting applies at once). */
  context(sessionId: string): Promise<GateContext>;
  /** Asks the user (ApprovalBroker.request). */
  request(sessionId: string, ask: Omit<ApprovalRequest, "id" | "expiresAt">, opts?: { timeoutMs?: number }): Promise<ApprovalOutcome>;
  /** Jev for what the rules are unsure about, for this session; null: rules only (unsure asks). */
  jev?(sessionId: string): SystemOneLike | null | Promise<SystemOneLike | null>;
  now?(): number;
}

/** An approval ends this long before the turn's time limit, so the agent still hears the answer. */
export const APPROVAL_TURN_MARGIN_MS = 30_000;

/** APPROVAL_GATED_METHODS as the classifier names them. */
export const GATED_METHODS: Record<ApprovalGatedMethod, GateMethod> = {
  "browser.click": "click",
  "browser.type": "type",
  "browser.paste": "paste",
  "browser.pressKey": "pressKey",
  "browser.upload": "upload",
  "browser.navigate": "navigate",
  "browser.openTabs": "openTabs",
  "browser.closeTabs": "closeTabs",
};

/** Typed fields remembered per page (a long form keeps its last ones). */
const MAX_TYPED = 8;
/** The text an approval card shows at most. */
const MAX_CARD_TEXT = 2000;
const ASK_ALL_WHY = "You asked to approve every action (Settings > AI > Automation)";

export class ApprovalGate {
  /** The session the slot serves now: "allow for this task" and what was typed belong to it. */
  private boundTo: string | null = null;
  private allowAll = false;
  /** The current tab's last page read. */
  private page: PageSnapshot | null = null;
  /**
   * The current tab's short id, as the calls' results say (a turn starts on t1; switch_tab, open_tabs shown, and
   * the tab lists change it): a read that names this tab (read_page with `tabs`) is a read of the current tab.
   */
  private current = MAIN_TAB;
  private typed: TypedField[] = [];

  constructor(
    private readonly inner: BrowserCaller,
    /** The session using the slot now (null: none, e.g. `mcp-server --attach`, where the user drives their own Claude Code). */
    private readonly sessionOf: () => string | null,
    private readonly deps: GateDeps,
    /** Called when the gate starts waiting for the user; returns what ends it (the turn's clock leaves the wait out). */
    private readonly waiting?: () => () => void,
  ) {}

  readonly browser: BrowserCaller = {
    call: async <M extends BrowserMethod>(method: M, params: BrowserMethods[M]["params"]) => {
      const sessionId = this.sessionOf();
      this.follow(sessionId);
      const gated = isApprovalGated(method) ? GATED_METHODS[method] : undefined;
      if (gated && sessionId) await this.check(sessionId, gated, params as Record<string, unknown>);
      const result = await this.inner.call(method, params);
      this.observe(method, params as Record<string, unknown>, result);
      return result;
    },
  };

  /** The session's turn ended (the slot is given back): "allow for this task" and what the gate knew are gone. */
  release(): void {
    this.boundTo = null;
    this.reset();
  }

  private follow(sessionId: string | null): void {
    if (sessionId === this.boundTo) return;
    this.boundTo = sessionId;
    this.reset();
  }

  private reset(): void {
    this.allowAll = false;
    this.current = MAIN_TAB;
    this.page = null;
    this.typed = [];
  }

  private async check(sessionId: string, method: GateMethod, params: Record<string, unknown>): Promise<void> {
    const ctx = await this.deps.context(sessionId);
    if (ctx.level === "full" || this.allowAll) return;
    const action = this.actionOf(method, params);
    const ask = await this.why(sessionId, ctx, action);
    if (!ask) return;
    const request = approvalAsk(action, ask.why, ask.kind);
    const now = this.deps.now?.() ?? Date.now();
    const left = ctx.endsAt === undefined ? undefined : Math.max(0, ctx.endsAt - now - APPROVAL_TURN_MARGIN_MS);
    const waited = this.waiting?.();
    const outcome = await this.deps.request(sessionId, request, left === undefined || left >= APPROVAL_TIMEOUT_MS ? undefined : { timeoutMs: left }).finally(() => waited?.());
    // An answer that comes after the turn ended (the slot moved on) does nothing.
    const still = this.sessionOf() === sessionId;
    if ((outcome === "allow_once" || outcome === "allow_task") && still) {
      if (outcome === "allow_task") this.allowAll = true;
      return;
    }
    throw new Error(approvalRefusalText(outcome === "allow_once" || outcome === "allow_task" ? "ended" : outcome, request.action));
  }

  /** Why this action waits at this level; null: it runs. */
  private async why(sessionId: string, ctx: GateContext, action: GateAction): Promise<{ why: string; kind?: ConsequenceKind } | null> {
    if (ctx.level === "ask_all") return { why: ASK_ALL_WHY };
    const jev = (await this.deps.jev?.(sessionId)) ?? null;
    const pageText = this.page?.text ?? "";
    const j = await judgeAction(action, { jev, pageText });
    if (!j.consequential) return null;
    const what = j.kind ? CONSEQUENCE_TEXT[j.kind] : "may publish, send, pay or delete (it could not be told apart)";
    if (ctx.level === "full_within_task") {
      const w = await judgeWithinTask(j.kind, action, ctx.instructions ?? "", { jev, pageText });
      if (w.within) return null;
      return { why: `${what}; the task does not ask for this`, ...(j.kind ? { kind: j.kind } : {}) };
    }
    return { why: what, ...(j.kind ? { kind: j.kind } : {}) };
  }

  private elementAt(index: unknown): ElementInfo | undefined {
    return typeof index === "number" ? this.page?.elements.find((e) => e.index === index) : undefined;
  }

  private actionOf(method: GateMethod, p: Record<string, unknown>): GateAction {
    const action: GateAction = { method, page: { url: this.page?.url ?? "", title: this.page?.title ?? "" }, typed: [...this.typed] };
    const element = this.elementAt(p.index);
    if (element) action.element = element;
    if (typeof p.checked === "boolean") action.checked = p.checked;
    if (typeof p.text === "string") action.text = p.text;
    if (typeof p.key === "string") action.key = p.key;
    if (typeof p.url === "string") action.urls = [p.url];
    if (Array.isArray(p.urls)) action.urls = p.urls.filter((u): u is string => typeof u === "string");
    if (Array.isArray(p.paths)) action.paths = p.paths.filter((u): u is string => typeof u === "string");
    if (Array.isArray(p.tabs)) action.tabs = p.tabs.filter((u): u is string => typeof u === "string");
    return action;
  }

  /** A tab list says which tab is current: a different one than known means the page known is not its page. */
  private follows(tabs: AgentTabInfo[] | undefined): void {
    const now = tabs?.find((t) => t.current)?.id;
    if (!now || now === this.current) return;
    this.current = now;
    this.page = null;
    this.typed = [];
  }

  /** Keeps what later actions need to be judged: the page read, and the fields typed into on it. */
  private observe(method: BrowserMethod, p: Record<string, unknown>, result: unknown): void {
    switch (method) {
      case "browser.readPage": {
        // Another tab's read (read_page with tabs) says nothing about the tab the actions go to; the current tab's does.
        if (typeof p.tab === "string" && normalizeId(p.tab) !== this.current) return;
        const snap = result as PageSnapshot;
        if (this.page && snap.url !== this.page.url) this.typed = [];
        this.page = snap;
        return;
      }
      case "browser.navigate":
        this.page = null;
        this.typed = [];
        return;
      case "browser.switchTab":
        this.current = (result as AgentTabInfo).id;
        this.page = null;
        this.typed = [];
        return;
      case "browser.openTabs":
        if (p.background === false) {
          this.follows((result as { tabs: AgentTabInfo[] }).tabs);
          this.page = null;
          this.typed = [];
        }
        return;
      case "browser.listTabs":
      case "browser.closeTabs":
        this.follows((result as { tabs: AgentTabInfo[] }).tabs);
        return;
      case "browser.type":
      case "browser.paste": {
        const element = this.elementAt(p.index) ?? this.typed.at(-1)?.element ?? { index: -1, tag: "", role: "textbox", name: "the focused field", inViewport: true };
        if (typeof p.text === "string") this.typed = [...this.typed.filter((t) => t.element.index !== element.index), { element, text: p.text }].slice(-MAX_TYPED);
        return;
      }
      case "browser.click": {
        // What was typed went out with (or was left by) a click on anything but a field.
        const el = this.elementAt(p.index);
        if (!el || !isField(el)) this.typed = [];
        return;
      }
      default:
        return;
    }
  }
}

/** The tab a run starts on (AgentTab: the main tab is t1 and current when a turn starts). */
const MAIN_TAB = "t1";

function isField(el: ElementInfo): boolean {
  return ["textbox", "searchbox", "combobox"].includes(el.role) || (el.tag === "input" && !["submit", "button", "checkbox", "radio", "image"].includes(el.type ?? "text")) || el.tag === "textarea";
}

// ------------------------------------------------------------------ the card's words

const quote = (s: string) => `"${s.length > 60 ? `${s.slice(0, 59)}…` : s}"`;

function elementName(el: ElementInfo | undefined): string {
  if (!el) return "an element";
  return quote(el.name || el.text || el.testId || el.role || el.tag);
}

/** The action in plain words: `Click "Post"`, `Press Control+Enter`, `Open example.com/delete`. */
export function describeAction(a: GateAction): string {
  switch (a.method) {
    case "click":
      if (a.checked !== undefined) return `${a.checked ? "Check" : "Uncheck"} ${elementName(a.element)}`;
      return `Click ${elementName(a.element)}`;
    case "type":
      return a.element?.options ? `Choose ${quote(a.text ?? "")} in ${elementName(a.element)}` : `Type into ${elementName(a.element)}`;
    case "paste":
      return "Paste text";
    case "pressKey":
      return `Press ${a.key ?? "a key"}`;
    case "upload": {
      const names = (a.paths ?? []).map((p) => p.split(/[\\/]/).pop() ?? p);
      return `Upload ${names.length === 1 ? names[0] : `${names.length} files`}`;
    }
    case "navigate":
      return `Open ${shortUrl(a.urls?.[0] ?? "")}`;
    case "openTabs":
      return (a.urls?.length ?? 0) === 1 ? `Open ${shortUrl(a.urls![0]!)} in a new tab` : `Open ${a.urls?.length ?? 0} tabs`;
    case "closeTabs":
      return `Close tab${(a.tabs?.length ?? 0) === 1 ? "" : "s"} ${(a.tabs ?? []).join(", ")}`;
  }
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}

/** The text the action posts or sends: what was typed on the page before it (never a password). */
function actionText(a: GateAction): string | undefined {
  if (a.method === "type" || a.method === "paste") return a.element?.type === "password" ? undefined : a.text;
  if (a.method !== "click" && a.method !== "pressKey") return undefined;
  const fields = a.typed.filter((t) => t.element.type !== "password" && t.text.trim());
  if (!fields.length) return undefined;
  if (fields.length === 1) return fields[0]!.text;
  return fields.map((t) => `${t.element.name || "Field"}: ${t.text}`).join("\n");
}

/** The approval request for an action that waits. */
export function approvalAsk(a: GateAction, why: string, kind?: ConsequenceKind): Omit<ApprovalRequest, "id" | "expiresAt"> {
  const where = a.method === "navigate" || a.method === "openTabs" ? (a.urls?.[0] ?? "") : a.page.url;
  const text = actionText(a);
  return {
    action: describeAction(a),
    site: hostOf(where),
    why,
    ...(kind ? { kind } : {}),
    ...(text ? { text: text.length > MAX_CARD_TEXT ? `${text.slice(0, MAX_CARD_TEXT - 1)}…` : text } : {}),
  };
}
