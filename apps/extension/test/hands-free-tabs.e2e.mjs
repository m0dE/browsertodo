// Hands-free voice with per-tab side panels, in the built extension (Playwright's Chromium, Chrome's fake microphone).
// Owner's report: "when i start voice in one tab, and jump to another tab, it also shows that voice is currently
// active. this is confusing ... other tabs should say voice is active on another tab, and there should be [go to tab]
// button ... because im talking to one voice and voice says 'i can't see what you're talking about'".
//
// Checked: hands-free started in tab A's panel; the user switches to tab B and opens B's panel. B's panel must not show
// the live voice UI (bar listening, mic button live, composer "Listening…" placeholder, voice-live body class) but the
// "elsewhere" notice naming tab A, with Go to tab, Use voice here and Stop. Use voice here moves the session to B (A's
// panel goes quiet, the MIC badge moves to B); Stop there ends it in A. While the user looks at B, A's panel knows it:
// what is said goes to A's chat with a note naming both tabs, and B's toolbar button has the grey MIC badge. Saying
// "use this tab" there moves the session to B (B's open panel takes it over).
//
// Usage: pnpm build && node apps/extension/test/hands-free-tabs.e2e.mjs [--headed]
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXTENSION_ID, launchExtension, panelPath } from "../../../test/e2e/lib/extension.mjs";
import { serveHtml } from "../../../test/e2e/lib/serve.mjs";
import { createSuite, waitFor } from "../../../test/e2e/lib/suite.mjs";
import { micAllowedPreferences, writeSpeechLikeWav } from "../../../test/fixtures/voice/speech-wav.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shots = join(root, "test", "ui", "screenshots", "e2e");
mkdirSync(shots, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "browsertodo-hf-tabs-"));
// Quiet after a short sound: the session listens and nothing is sent.
const audioFile = writeSpeechLikeWav(join(scratch, "speech.wav"), { seconds: 10 });

/**
 * Runs in a side panel before its scripts: signed in on Plus with the Standard engine (the mic unlocked), no message
 * goes out (window.__sent), speech is not said aloud, and window.__pushToPanel(msg) delivers a message as the
 * background's UI port would. The ports and every other request are the real ones.
 */
const STUBS = `(() => {
  const plus = (s) => {
    if (!s || typeof s !== "object" || !("settings" in s) || !("brain" in s)) return s;
    const a = s.account ?? {};
    return { ...s, settings: { ...s.settings, voiceEngine: "standard" },
      account: { ...a, signedIn: true, user: { email: "voice@example.com", name: "Voice Test", pictureUrl: null },
        plan: { id: "plus", status: "active", currentPeriodEnd: null, cancelAtPeriodEnd: false },
        credit: { subscriptionCents: 1000, topupCents: 0, totalCents: 1000, periodGrantCents: 2000, periodEnd: null } } };
  };
  const send = chrome.runtime.sendMessage.bind(chrome.runtime);
  window.__sent = [];
  chrome.runtime.sendMessage = async (msg, ...rest) => {
    if (msg?.type === "voice.transcribe") return { ok: true, data: { text: window.__transcript ?? "What is on this page?" } };
    if (msg?.type === "run.message" && msg.voice) { window.__sent.push({ text: msg.text, context: msg.context ?? null, tabId: msg.tabId ?? null, sessionId: msg.sessionId ?? null }); return { ok: true, data: { sessionId: "s-hf", mode: "new" } }; }
    const res = await send(msg, ...rest);
    return res?.ok ? { ...res, data: plus(res.data) } : res;
  };
  const connect = chrome.runtime.connect.bind(chrome.runtime);
  const listeners = [];
  window.__pushToPanel = (m) => listeners.forEach((l) => l(m));
  chrome.runtime.connect = (...args) => {
    const port = connect(...args);
    const addListener = port.onMessage.addListener.bind(port.onMessage);
    port.onMessage.addListener = (l) => { listeners.push(l); addListener((m) => l(m?.type === "state" ? { ...m, state: plus(m.state) } : m)); };
    return port;
  };
  window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  Object.defineProperty(window, "speechSynthesis", { configurable: true, value: {
    speak(u) { setTimeout(() => u.onend?.(), 50); }, cancel() {}, getVoices: () => [], addEventListener() {}, removeEventListener() {} } });
})();`;

/** What a panel shows of voice: the bar, the mic button, the box, and the page's live marks. */
const VOICE_LOOK = `(() => {
  const bar = document.getElementById("voice-bar");
  const mic = document.querySelector("#now-actions .voice-mic");
  const box = document.getElementById("now-text");
  const vis = (el) => !!el && !el.hidden && getComputedStyle(el).display !== "none";
  return {
    bar: { shown: !bar.hidden, state: bar.hidden ? null : bar.dataset.state ?? null, phase: bar.dataset.phase ?? null,
      title: bar.querySelector(".vb-title")?.textContent ?? "", detail: bar.querySelector(".vb-detail")?.textContent ?? "",
      go: vis(bar.querySelector(".vb-go")) && !bar.querySelector(".vb-links").hidden,
      use: vis(bar.querySelector(".vb-use")) && !bar.querySelector(".vb-links").hidden,
      useText: bar.querySelector(".vb-use")?.textContent ?? "",
      stop: vis(bar.querySelector(".vb-stop")), meter: vis(bar.querySelector(".vb-meter")) },
    mic: { state: mic?.dataset.state ?? null, pressed: mic?.getAttribute("aria-pressed") ?? null, title: mic?.title ?? "" },
    box: { placeholder: box?.placeholder ?? "", classes: box?.className ?? "" },
    voiceLive: document.body.classList.contains("voice-live"),
    orb: vis(document.querySelector(".voice-orb")),
  };
})()`;

/** A DevTools target by its URL (a real side panel is not a Playwright page): evaluate, send, screenshot. */
async function cdpTarget(port, match) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((t) => t.type !== "service_worker" && match(t.url));
  if (!target) return null;
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  };
  const send = (method, params) =>
    new Promise((resolve) => {
      pending.set(++id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  return {
    send,
    async evaluate(expression) {
      const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text);
      return res.result?.result?.value;
    },
    async screenshot(file) {
      const r = await send("Page.captureScreenshot", { format: "png" });
      if (r.result?.data) writeFileSync(file, Buffer.from(r.result.data, "base64"));
    },
    close: () => ws.close(),
  };
}

const site = await serveHtml((path) => `<!doctype html><title>${path.includes("b") ? "Recipes B" : "Shop A"}</title><body><h1>${path}</h1></body>`);
const { step, finish } = createSuite("hands-free-tabs");
const ext = await launchExtension({
  name: "hf-tabs",
  prefs: micAllowedPreferences(EXTENSION_ID),
  args: ["--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${audioFile}`, "--remote-debugging-port=0"],
});
const { context, sw, extensionId, profile } = ext;
const devtoolsPort = await waitFor(() => Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]), "DevToolsActivePort");
const isPanelOf = (tab) => (url) => URL.canParse(url) && new URL(url).pathname === "/sidepanel.html" && new URL(url).searchParams.get("tab") === String(tab);
const badgeOf = (tabId) => sw.evaluate(async (t) => chrome.action.getBadgeText({ tabId: t }), tabId);
/** A tab's badge: its text and colour ("live" red, "elsewhere" grey, as MUTE is too; see voice-session.ts VOICE_BADGES). */
const badgeLook = (tabId) =>
  sw.evaluate(async (t) => {
    const text = await chrome.action.getBadgeText({ tabId: t });
    if (!text) return "";
    const [r, g, b] = await chrome.action.getBadgeBackgroundColor({ tabId: t });
    return `${text}:${r === 200 && g === 35 && b === 63 ? "live" : r === 128 && g === 134 && b === 139 ? "elsewhere" : `${r},${g},${b}`}`;
  }, tabId);
const opened = [];

/** Opens tab `tabId`'s own panel from `opener` (an extension page), stubs it (Plus) and waits until its mic is unlocked. */
async function openPanel(opener, tabId) {
  // As the extension opens a tab's panel (panel-tabs.ts openTabPanel), in a user gesture: a trusted click in an extension page.
  await opener.evaluate(([tabId, path]) => {
    document.getElementById("gesture-open")?.remove();
    const b = document.createElement("button");
    b.id = "gesture-open";
    b.textContent = "open";
    b.onclick = () => {
      chrome.sidePanel.setOptions({ tabId, path, enabled: true });
      chrome.sidePanel.open({ tabId });
    };
    document.body.append(b);
  }, [tabId, panelPath(tabId)]);
  await opener.click("#gesture-open");
  const panel = await waitFor(() => cdpTarget(devtoolsPort, isPanelOf(tabId)), `tab ${tabId}'s side panel target`);
  opened.push(panel);
  await panel.send("Page.enable");
  await panel.send("Page.addScriptToEvaluateOnNewDocument", { source: STUBS });
  await panel.send("Page.reload", {});
  await waitFor(() => panel.evaluate(`document.querySelector("#now-actions .voice-mic")?.dataset.state === "idle"`), `tab ${tabId}'s panel on Plus`, { timeout: 15_000 });
  return panel;
}

try {
  const pageA = await context.newPage();
  await pageA.goto(`${site.base}/a`);
  const pageB = await context.newPage();
  await pageB.goto(`${site.base}/b`);
  // The extension page whose click opens the panels (a user gesture), in the same window.
  const opener = await context.newPage();
  await opener.goto(`chrome-extension://${extensionId}/mic-permission.html#opener`);
  const ids = await sw.evaluate(async (base) => {
    const a = (await chrome.tabs.query({ url: `${base}/a` }))[0];
    const b = (await chrome.tabs.query({ url: `${base}/b` }))[0];
    return { a: a.id, b: b.id, windowId: a.windowId };
  }, site.base);
  const activate = (tab) => sw.evaluate((t) => chrome.tabs.update(t, { active: true }), tab);

  let panelA;
  await step("hands-free starts in tab A's panel: the live bar, and the MIC badge on tab A", async () => {
    await activate(ids.a);
    panelA = await openPanel(opener, ids.a);
    await panelA.evaluate(`window.__pushToPanel({ type: "panel.voice" })`);
    await waitFor(() => panelA.evaluate(`document.getElementById("voice-bar").dataset.phase === "listening"`), "A listening", { timeout: 10_000 });
    assert.equal(await waitFor(async () => (await badgeOf(ids.a)) || null, "MIC on A"), "MIC");
    const look = await panelA.evaluate(VOICE_LOOK);
    assert.ok(look.bar.shown && look.bar.state !== "elsewhere" && look.voiceLive, JSON.stringify(look));
    return JSON.stringify(look);
  });

  await step("switching to tab B (no panel of its own yet): A's panel knows, what is said carries a note naming both tabs, B's button has the grey badge", async () => {
    const before = await panelA.evaluate(`window.__sent.length`);
    await activate(ids.b);
    await waitFor(() => panelA.evaluate(`document.visibilityState === "hidden"`), "A's panel to hide");
    await waitFor(() => panelA.evaluate(`document.getElementById("voice-bar").dataset.state === "elsewhere"`), "A's bar to say it listens elsewhere");
    const look = await panelA.evaluate(VOICE_LOOK);
    // Said while the user looks at tab B: to A's chat as said, with the note as the message's context (the agent gets it, the chat does not show it).
    const said = await waitFor(() => panelA.evaluate(`window.__sent[${before}] ?? null`), "a message said while tab B shows", { timeout: 30_000 });
    const badges = { a: await badgeLook(ids.a), b: await badgeLook(ids.b) };
    const evidence = JSON.stringify({ said, tabA: ids.a, tabB: ids.b, aLook: look, badges });
    assert.equal(look.bar.state, "elsewhere", `A knows the user left its tab: ${evidence}`);
    assert.equal(look.voiceLive, false, evidence);
    assert.equal(said.tabId, ids.a, evidence);
    assert.equal(said.text, "What is on this page?", evidence);
    assert.match(said.context ?? "", /^The user is looking at another tab: Recipes B \(127\.0\.0\.1:\d+\)\. You work in Shop A \(127\.0\.0\.1:\d+\)\.$/, evidence);
    assert.deepEqual(badges, { a: "MIC:live", b: "MIC:elsewhere" }, evidence);
    return evidence;
  });

  let panelB;
  await step("the user switches to tab B and opens its panel: B says voice is on in tab A (Go to tab, Use voice here, Stop), nothing live", async () => {
    await activate(ids.b);
    panelB = await openPanel(opener, ids.b);
    // B's panel has had time to learn about A's session.
    await new Promise((r) => setTimeout(r, 1500));
    const look = await panelB.evaluate(VOICE_LOOK);
    await panelB.screenshot(join(shots, "hands-free-tabs-B.png"));
    const badges = { a: await badgeLook(ids.a), b: await badgeLook(ids.b) };
    const evidence = JSON.stringify({ look, badges });
    // Nothing live in B.
    assert.equal(look.voiceLive, false, `B is not live: ${evidence}`);
    assert.notEqual(look.bar.state, "listening", evidence);
    assert.notEqual(look.bar.state, "hearing", evidence);
    assert.ok(!/Listening/i.test(look.box.placeholder), `B's box does not say it listens: ${evidence}`);
    assert.notEqual(look.mic.state, "handsfree", `B's mic is not live: ${evidence}`);
    // B's button: the grey badge (voice is on elsewhere), not the live one.
    assert.deepEqual(badges, { a: "MIC:live", b: "MIC:elsewhere" }, evidence);
    // The notice naming A, with its buttons.
    assert.ok(look.bar.shown, `B shows a notice that voice is on in another tab: ${evidence}`);
    assert.equal(look.bar.state, "elsewhere", evidence);
    assert.match(look.bar.title, /Shop A/, evidence);
    assert.ok(look.bar.go && look.bar.use && look.bar.stop, evidence);
    assert.equal(look.bar.meter, false, `no live meter on B: ${evidence}`);
    return evidence;
  });

  await step("Use voice here in B moves the session to B: B goes live, A goes quiet, the badge moves", async () => {
    await panelB.evaluate(`document.querySelector("#voice-bar .vb-use").click()`);
    await waitFor(() => panelB.evaluate(`document.body.classList.contains("voice-live")`), "B live");
    await waitFor(async () => !(await panelA.evaluate(VOICE_LOOK)).voiceLive, "A no longer live");
    await waitFor(async () => (await badgeLook(ids.b)) === "MIC:live" && (await badgeLook(ids.a)) === "", "the badge to move to B");
    return JSON.stringify({ a: await panelA.evaluate(VOICE_LOOK), b: await panelB.evaluate(VOICE_LOOK) });
  });

  await step("Stop in A's notice ends the session in B: both quiet, no badge", async () => {
    await activate(ids.a);
    await waitFor(() => panelA.evaluate(`document.getElementById("voice-bar").dataset.state === "elsewhere"`), "A's notice");
    await panelA.evaluate(`document.querySelector("#voice-bar .vb-stop").click()`);
    await waitFor(async () => !(await panelB.evaluate(VOICE_LOOK)).bar.shown && !(await panelA.evaluate(VOICE_LOOK)).bar.shown, "both bars gone");
    await waitFor(async () => (await badgeOf(ids.b)) === "" && (await badgeOf(ids.a)) === "", "no badge");
    return "ended";
  });

  await step("voice on in A again; on tab B the user says 'use this tab': it moves to B (B's open panel takes it over), one session", async () => {
    await activate(ids.a);
    await panelA.evaluate(`window.__pushToPanel({ type: "panel.voice" })`);
    await waitFor(() => panelA.evaluate(`document.body.classList.contains("voice-live")`), "A live again", { timeout: 10_000 });
    await activate(ids.b);
    await waitFor(() => panelA.evaluate(`document.getElementById("voice-bar").dataset.state === "elsewhere"`), "A knows the user looks at B");
    await panelA.evaluate(`window.__transcript = "Use this tab."`);
    await waitFor(() => panelB.evaluate(`document.body.classList.contains("voice-live")`), "B to take the session over", { timeout: 30_000 });
    await waitFor(async () => (await badgeLook(ids.b)) === "MIC:live" && (await badgeLook(ids.a)) === "", "the badge on B");
    const a = await panelA.evaluate(VOICE_LOOK);
    assert.equal(a.voiceLive, false, JSON.stringify(a));
    assert.equal(await panelA.evaluate(`window.__sent.some((m) => /use this tab/i.test(m.text))`), false, "'use this tab' is not sent to the agent");
    const session = await sw.evaluate(() => globalThis.__browsertodo.voiceSessions.view());
    assert.equal(session.tabId, ids.b, JSON.stringify(session));
    assert.equal(session.host, ids.b, JSON.stringify(session));
    await panelB.evaluate(`document.querySelector("#voice-bar .vb-stop").click()`);
    await waitFor(async () => (await badgeOf(ids.b)) === "", "stopped");
    return JSON.stringify({ session, a });
  });

  await step("muted in A: MUTE badges (grey) on A and on B looked at instead, B's notice says so; Use voice here in B keeps it muted", async () => {
    await activate(ids.a);
    await panelA.evaluate(`window.__pushToPanel({ type: "panel.voice" })`);
    await waitFor(() => panelA.evaluate(`document.getElementById("voice-bar").dataset.phase === "listening"`), "A listening", { timeout: 10_000 });
    await panelA.evaluate(`document.querySelector("#voice-bar .vb-mute").click()`);
    await waitFor(async () => (await badgeLook(ids.a)) === "MUTE:elsewhere", "the grey MUTE badge on A");
    const a = await panelA.evaluate(VOICE_LOOK);
    assert.ok(a.bar.state === "muted" && !a.voiceLive && !a.bar.meter, JSON.stringify(a));
    await activate(ids.b);
    await waitFor(async () => (await badgeLook(ids.b)) === "MUTE:elsewhere", "the grey MUTE badge on B");
    await waitFor(() => panelB.evaluate(`/Muted/.test(document.querySelector("#voice-bar .vb-detail").textContent)`), "B's notice to say it is muted");
    const bNotice = await panelB.evaluate(VOICE_LOOK);
    await panelB.evaluate(`document.querySelector("#voice-bar .vb-use").click()`);
    await waitFor(() => panelB.evaluate(`document.getElementById("voice-bar").dataset.state === "muted"`), "B to run the session, muted", { timeout: 10_000 });
    await waitFor(async () => (await badgeLook(ids.b)) === "MUTE:elsewhere" && (await badgeLook(ids.a)) === "", "the MUTE badge moved to B");
    const b = await panelB.evaluate(VOICE_LOOK);
    assert.equal(b.voiceLive, false, JSON.stringify(b));
    assert.match(b.box.placeholder, /muted/i, JSON.stringify(b));
    const session = await sw.evaluate(() => globalThis.__browsertodo.voiceSessions.view());
    assert.equal(session.muted, true, JSON.stringify(session));
    await panelB.screenshot(join(shots, "hands-free-tabs-B-muted.png"));
    // Unmuted there, the badge is the live MIC again.
    await panelB.evaluate(`document.querySelector("#voice-bar .vb-mute").click()`);
    await waitFor(async () => (await badgeLook(ids.b)) === "MIC:live", "MIC on B once unmuted");
    await panelB.evaluate(`document.querySelector("#voice-bar .vb-stop").click()`);
    await waitFor(async () => (await badgeOf(ids.b)) === "", "stopped");
    return JSON.stringify({ aMuted: a.bar, bNotice: bNotice.bar.detail, bMuted: b.bar, session });
  });
} finally {
  for (const p of opened) p.close();
  await ext.close();
  await site.close();
  rmSync(scratch, { recursive: true, force: true });
}
finish();
