// The side panel's and options page's `chrome` without the real background: a stub installed in
// the page before any script (page.addInitScript(installChromeStub, data)), answering UI requests
// from canned data (scenarios.mjs) and recording what the page sent.

/** Runs in the page before any script: a minimal chrome.runtime. */
export function installChromeStub(data) {
  // Like the real background (engine/ui-router.ts), every state lists all running sessions;
  // scenarios name only the latest (`running`) unless they set more.
  const withRunning = (s) => (s.runningSessions ? s : { ...s, runningSessions: s.running ? [s.running] : [] });
  data.state = withRunning(data.state);
  data.vault ??= { exists: true, locked: false, sites: ["example.com", "news.ycombinator.com"] };
  const pushListeners = [];
  const results = {
    "state.get": () => data.state,
    "settings.save": (req) => {
      const s = { ...data.state.settings, ...req.settings };
      for (const k of ["anthropicApiKey", "jevApiKey", "runnerKey"]) if (k in req.settings) s[k] = req.settings[k] ? "set" : "";
      data.state = { ...data.state, settings: s };
      return data.state;
    },
    "settings.testClaude": () => ({ ok: true, detail: "Claude answered in 1.2 s (claude-sonnet-5)." }),
    "settings.testJev": () => ({ ok: false, detail: "No Jev key set." }),
    "settings.testCloud": () => ({ ok: true, detail: "Server reachable, runner key accepted." }),
    "helper.connect": () => data.state,
    "run.adhoc": (req) => {
      const title = req.screen ? "Figure out what to do based on the current screen" : req.instructions;
      const s = { sessionId: "s-new", source: "adhoc", title, brain: "claude-api", jev: true, startedAt: new Date().toISOString() };
      data.sessions = [s, ...data.sessions.filter((x) => x.sessionId !== "s-new")];
      data.eventsBySession = { ...(data.eventsBySession ?? {}), "s-new": [] };
      return { sessionId: "s-new" };
    },
    "run.due": () => ({ started: false, detail: "Nothing is due right now." }),
    "run.stop": () => ({ ok: true }),
    "run.continue": (req) => ({ sessionId: req.sessionId }),
    "run.message": (req) => ({ sessionId: req.sessionId ?? "s-new", mode: req.sessionId ? "turn" : "new" }),
    "run.newChat": (req) => {
      if (req.tabId !== undefined && data.state.tabChats?.[req.tabId] === req.sessionId) {
        const rest = { ...data.state.tabChats };
        delete rest[req.tabId];
        data.state = { ...data.state, tabChats: rest };
      }
      return { ok: true };
    },
    "chat.bind": (req) => {
      const rest = Object.fromEntries(Object.entries(data.state.tabChats ?? {}).filter(([, id]) => id !== req.sessionId));
      data.state = { ...data.state, tabChats: { ...rest, [req.tabId]: req.sessionId } };
      return data.state;
    },
    "tab.focus": (req) => {
      setTimeout(() => window.__activateTab(req.tabId), 0);
      return { ok: true };
    },
    "agent.show": () => ({ ok: true }),
    "schedule.pause": () => ({ ...data.state, paused: true }),
    "schedule.resume": () => ({ ...data.state, paused: false }),
    "tasks.list": () => ({ tasks: data.tasks, locked: !!data.tasksLocked, ...(data.tasksSource ? { source: data.tasksSource } : {}) }),
    "tasks.cancel": (req) => ({ task: { ...data.tasks.find((t) => t.id === req.id), status: "cancelled" } }),
    "account.signIn": () => {
      data.state = { ...data.state, account: { ...data.state.account, signedIn: true, user: { email: "ada.lovelace@example.com", name: "Ada Lovelace", pictureUrl: null }, plan: data.signInPlan } };
      return data.state;
    },
    "account.signOut": () => {
      const a = data.state.account;
      data.state = { ...data.state, account: { signedIn: false, signInConfigured: a.signInConfigured, apiBase: a.apiBase, dashboardUrl: a.dashboardUrl, billingUrl: a.billingUrl } };
      return data.state;
    },
    "account.refresh": () => data.state,
    "account.migrate": () => {
      const moved = data.state.account.localTasks ?? 0;
      data.state = { ...data.state, account: { ...data.state.account, localTasks: undefined } };
      return { moved, failed: 0, errors: [], state: data.state };
    },
    "account.dismissMigration": () => {
      data.state = { ...data.state, account: { ...data.state.account, localTasks: undefined } };
      return data.state;
    },
    "account.keys.list": () => ({ keys: data.keys ?? [] }),
    "account.keys.create": (req) => {
      const k = { id: `k${(data.keys?.length ?? 0) + 1}`, name: req.name, role: req.role, createdAt: new Date().toISOString(), revokedAt: null };
      data.keys = [...(data.keys ?? []), k];
      return { id: k.id, name: k.name, role: k.role, key: "bt_EXAMPLE_not_a_real_key_0000000000000000" };
    },
    "account.keys.revoke": (req) => {
      data.keys = (data.keys ?? []).filter((k) => k.id !== req.id);
      return { ok: true };
    },
    "tasks.add": () => ({ task: data.tasks[0] }),
    "tasks.delete": () => ({ ok: true }),
    "tasks.retry": () => ({ task: data.tasks[0] }),
    "sessions.list": (req) => ({ sessions: data.sessions.filter((s) => req.taskId === undefined || s.taskId === req.taskId) }),
    "sessions.events": (req) =>
      data.eventsBySession?.[req.sessionId]
        ? { session: data.sessions.find((s) => s.sessionId === req.sessionId) ?? data.state.running, events: data.eventsBySession[req.sessionId] }
        : req.sessionId === "s-live"
        ? { session: data.sessions[0], events: data.events }
        : { session: data.sessions.find((s) => s.sessionId === req.sessionId), events: data.pastEvents },
    // Site logins: data.vault is the vault's state (unlocked with two logins unless a case sets it);
    // "correct horse" is the passphrase that opens an existing vault.
    "vault.list": () => data.vault,
    "vault.unlock": (req) => {
      if (data.vault.exists && req.passphrase !== "correct horse") return { ok: false };
      data.vault = { ...data.vault, exists: true, locked: false };
      return { ok: true };
    },
    "vault.lock": () => {
      data.vault = { ...data.vault, locked: true };
      return { ok: true };
    },
    "vault.set": (req) => {
      data.vault = { ...data.vault, sites: [...new Set([...data.vault.sites, req.site])].sort() };
      return { ok: true };
    },
    "vault.delete": (req) => {
      data.vault = { ...data.vault, sites: data.vault.sites.filter((s) => s !== req.site) };
      return { ok: true };
    },
    "vault.reset": () => {
      data.vault = { exists: false, locked: true, sites: [] };
      return { ok: true };
    },
    // Voice input: each clip says a little more of the sentence. __voiceHold keeps the next answer
    // back until __voiceRelease() (to show "Finishing…").
    "voice.transcribe": () => {
      const words = "Open Gmail and reply to Sarah that I will be there at seven.".split(" ");
      window.__voiceClips = (window.__voiceClips ?? 0) + 1;
      const text = words.slice(0, Math.min(words.length, 3 * window.__voiceClips)).join(" ");
      if (!window.__voiceHold) return { text };
      return new Promise((resolve) => (window.__voiceRelease = () => resolve({ text: words.join(" ") })));
    },
  };
  window.__requests = [];
  /** The canned answers, for a case that changes them mid-way (e.g. a subscription unlocking the TODO list). */
  window.__data = data;
  window.__opened = [];
  /** What the panel sent on its UI port (panel.hello, panel.input), and tabs it opened. */
  window.__portSent = [];
  window.__created = [];
  window.open = (url) => void window.__opened.push(url);
  window.__push = (msg) => {
    // A pushed state is the background's state from then on.
    if (msg.type === "state") {
      msg = { ...msg, state: withRunning(msg.state) };
      data.state = msg.state;
    }
    pushListeners.forEach((l) => l(msg));
  };
  // One window (1) with tabs; tab 1 is active. __activateTab(n) is the user switching tabs.
  const tabListeners = [];
  let activeTabId = 1;
  window.__activateTab = (tabId) => {
    activeTabId = tabId;
    tabListeners.forEach((l) => l({ tabId, windowId: 1 }));
  };
  const noEvent = { addListener: () => {} };
  window.chrome = {
    runtime: {
      id: "abcdefghijklmnopabcdefghijklmnop",
      sendMessage: async (req) => {
        window.__requests.push(req);
        // __refuse[type] = "text": that request fails with this error (as the background would answer).
        const refusal = window.__refuse?.[req.type];
        if (refusal) return { ok: false, error: refusal };
        const fn = results[req.type];
        return fn ? { ok: true, data: await fn(req) } : { ok: false, error: `unknown request ${req.type}` };
      },
      connect: () => ({
        onMessage: { addListener: (l) => pushListeners.push(l) },
        onDisconnect: { addListener: () => {} },
        postMessage: (m) => void window.__portSent.push(m),
      }),
      openOptionsPage: () => {},
      getURL: (path) => `${location.origin}/${path}`,
    },
    commands: { getAll: async () => [{ name: "open-chat", shortcut: data.shortcut, description: "Open browsertodo" }] },
    tabs: {
      create: async (props) => {
        window.__created.push(props.url);
        return { id: 99, windowId: 1 };
      },
      // A query for a URL finds no tab (so pages such as the microphone page open in a new one).
      query: async (q) => (q?.url ? [] : [{ id: activeTabId, windowId: 1, active: true }]),
      update: async () => ({}),
      getCurrent: async () => ({ id: 99, windowId: 1 }),
      remove: async () => {},
      onActivated: { addListener: (l) => tabListeners.push(l) },
      onAttached: noEvent,
      onDetached: noEvent,
    },
    windows: { getCurrent: async () => ({ id: 1 }), update: async () => ({}), onFocusChanged: noEvent },
  };
}
