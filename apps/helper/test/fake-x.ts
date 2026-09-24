/**
 * A tiny in-memory model of X's compose page and account switcher that
 * answers `browser.*` RPC methods the way the extension would.
 */
import type { BrowserMethod, BrowserMethods, ElementInfo, PageSnapshot } from "@browsertodo/shared";

interface Action {
  el: ElementInfo;
  onClick?: () => void;
  onType?: (text: string) => void;
  onUpload?: (paths: string[]) => void;
}

export interface FakeXOptions {
  url?: string;
  account?: string;
  accounts?: string[];
  hasSwitcher?: boolean;
  credentials?: Record<string, { username: string; password: string }>;
  vaultLocked?: boolean;
}

export class FakeX {
  url: string;
  account: string;
  accounts: string[];
  hasSwitcher: boolean;
  menuOpen = false;
  composeText = "";
  files: string[] = [];
  posts: { account: string; text: string; files: string[]; url: string }[] = [];
  calls: { method: string; params: unknown }[] = [];
  credentials: Record<string, { username: string; password: string }>;
  vaultLocked: boolean;
  private actions: Action[] = [];

  constructor(opts: FakeXOptions = {}) {
    this.url = opts.url ?? "https://x.com/compose/post";
    this.account = opts.account ?? "alice";
    this.accounts = opts.accounts ?? ["alice", "bob", "carol"];
    this.hasSwitcher = opts.hasSwitcher ?? true;
    this.credentials = opts.credentials ?? {};
    this.vaultLocked = opts.vaultLocked ?? false;
  }

  private isLogin(): boolean {
    return this.url.includes("/i/flow/login");
  }

  private isX(): boolean {
    try {
      return new URL(this.url).hostname === "x.com";
    } catch {
      return false;
    }
  }

  title(): string {
    if (this.isLogin()) return "Log in to X / X";
    return this.isX() ? "Home / X" : "Blank";
  }

  snapshot(): PageSnapshot {
    const actions: Action[] = [];
    const add = (el: Omit<ElementInfo, "index" | "inViewport"> & { inViewport?: boolean }, handlers: Omit<Action, "el"> = {}) => {
      actions.push({ el: { inViewport: true, ...el, index: actions.length }, ...handlers });
    };
    let text = "";
    if (this.isLogin()) {
      add({ tag: "input", role: "textbox", name: "Phone, email, or username", type: "text" });
      add({ tag: "input", role: "textbox", name: "Password", type: "password" });
      text = "Sign in to X";
    } else if (this.isX()) {
      if (this.hasSwitcher) {
        add(
          { tag: "button", role: "button", name: "Account menu", text: `${this.account} @${this.account}`, testId: "SideNav_AccountSwitcher_Button" },
          { onClick: () => (this.menuOpen = !this.menuOpen) },
        );
      }
      if (this.menuOpen) {
        for (const acc of this.accounts) {
          add(
            { tag: "div", role: "button", name: `${acc[0]!.toUpperCase()}${acc.slice(1)} @${acc}`, testId: "UserCell" },
            {
              onClick: () => {
                this.account = acc;
                this.menuOpen = false;
                this.url = "https://x.com/home";
              },
            },
          );
        }
        add({ tag: "a", role: "link", name: "Add an existing account", href: "https://x.com/i/flow/login" });
      }
      add({ tag: "a", role: "link", name: "Home", href: "https://x.com/home", testId: "AppTabBar_Home_Link" });
      add(
        { tag: "div", role: "textbox", name: "Post text", testId: "tweetTextarea_0", value: this.composeText || undefined },
        { onType: (t) => (this.composeText += t) },
      );
      add({ tag: "input", role: "textbox", name: "Choose files", type: "file", testId: "fileInput", inViewport: false }, { onUpload: (p) => (this.files = p) });
      add(
        {
          tag: "button",
          role: "button",
          name: "Post",
          testId: this.url.includes("/compose/") ? "tweetButton" : "tweetButtonInline",
          disabled: this.composeText.length === 0,
        },
        {
          onClick: () => {
            if (!this.composeText) return;
            const url = `https://x.com/${this.account}/status/${1000 + this.posts.length}`;
            this.posts.push({ account: this.account, text: this.composeText, files: this.files, url });
            this.composeText = "";
            this.files = [];
            this.url = url;
          },
        },
      );
      text = `What is happening?! Signed in as @${this.account}`;
    }
    this.actions = actions;
    return { url: this.url, title: this.title(), text, elements: actions.map((a) => a.el), truncated: false };
  }

  private find(index: number): Action {
    const a = this.actions[index];
    if (!a) throw new Error(`element ${index} not found; call read_page again`);
    return a;
  }

  async handle<M extends BrowserMethod>(method: M, params: BrowserMethods[M]["params"]): Promise<BrowserMethods[M]["result"]> {
    this.calls.push({ method, params });
    const p = params as Record<string, any>;
    const r = await this.dispatch(method, p);
    return r as BrowserMethods[M]["result"];
  }

  private async dispatch(method: string, p: Record<string, any>): Promise<unknown> {
    switch (method) {
      case "browser.navigate":
        this.url = p.url;
        this.menuOpen = false;
        this.snapshot();
        return { url: this.url, title: this.title() };
      case "browser.readPage":
        return this.snapshot();
      case "browser.screenshot":
        return { base64: Buffer.from("fake-jpeg").toString("base64"), mimeType: "image/jpeg" };
      case "browser.click":
        this.find(p.index).onClick?.();
        return { ok: true };
      case "browser.type": {
        const a = this.find(p.index);
        if (!a.onType) throw new Error(`element ${p.index} is not editable`);
        a.onType(p.text);
        return { ok: true };
      }
      case "browser.paste":
      case "browser.pressKey":
      case "browser.scroll":
        return { ok: true };
      case "browser.upload": {
        const a = this.find(p.index);
        if (!a.onUpload) throw new Error(`element ${p.index} is not a file input`);
        a.onUpload(p.paths);
        return { ok: true };
      }
      case "browser.currentUrl":
        return { url: this.url };
      case "vault.getCredential": {
        if (this.vaultLocked) return { found: false, locked: true };
        const c = this.credentials[p.site];
        return c ? { found: true, ...c } : { found: false };
      }
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  /** A BrowserCaller backed by this fake. */
  caller() {
    return {
      call: <M extends BrowserMethod>(method: M, params: BrowserMethods[M]["params"]) => this.handle(method, params),
    };
  }
}
