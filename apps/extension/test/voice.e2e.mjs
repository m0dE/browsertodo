// Voice input in the built extension in Playwright's Chromium: the microphone permission (asked on
// mic-permission.html, used by the side panel) and the capture pipeline (AudioWorklet at 16 kHz, speech
// detection, live re-transcription) running in the real side panel on Chrome's fake microphone.
//
// Chrome's fake microphone plays a WAV file in a loop (--use-file-for-fake-audio-capture); there is no
// --use-fake-ui-for-media-stream, so permission prompts behave as for a user. Headless Chromium refuses
// prompts and nothing can click one, so the user's "Allow" is the entry Chrome stores for that click,
// written into the profile before launch (CDP cannot grant permissions to chrome-extension origins).
//
// Usage: pnpm build && node apps/extension/test/voice.e2e.mjs [--headed] [--audio=<16 kHz mono WAV of speech>]
// Without --audio a clip is synthesized (a voice-like tone in syllables with pauses).
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXTENSION_ID, launchExtension, openSidePanel } from "../../../test/e2e/lib/extension.mjs";
import { createSuite, waitFor } from "../../../test/e2e/lib/suite.mjs";
import { micAllowedPreferences, writeSpeechLikeWav } from "../../../test/fixtures/voice/speech-wav.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const audioArg = process.argv.find((a) => a.startsWith("--audio="))?.slice("--audio=".length);
/** Live re-transcription requests the capture step waits for (and expects), and how long it may take. */
const LIVE_REQUESTS = 3;
const LIVE_TIMEOUT_MS = 15_000;

const scratch = mkdtempSync(join(tmpdir(), "browsertodo-voice-"));
const audioFile = audioArg ?? writeSpeechLikeWav(join(scratch, "speech.wav"));

// The voice modules as one script for the side panel (evaluated over CDP, which the page's CSP allows).
const voiceBundle = (
  await build({
    stdin: {
      contents: `import { Dictation } from "./src/voice/dictation.ts"; import { MicSource } from "./src/voice/recorder.ts";
        globalThis.__voice = { Dictation, MicSource };`,
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    write: false,
  })
).outputFiles[0].text;

/**
 * A page Playwright does not expose (the side panel), driven over raw CDP on `devtoolsPort`:
 * evaluate(fn, arg) runs fn(arg) in it and returns the (JSON) result.
 */
async function cdpPage(devtoolsPort, urlSuffix) {
  const targets = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json();
  const target = targets.find((t) => t.url.endsWith(urlSuffix) && t.type !== "service_worker" && !t.url.includes("#opener"));
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
    async evaluate(fn, arg) {
      const expression = typeof fn === "string" ? fn : `(${fn})(${JSON.stringify(arg ?? null)})`;
      const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text);
      return res.result?.result?.value;
    },
    close: () => ws.close(),
  };
}

/** The DevTools port Chromium picked for --remote-debugging-port=0 (it writes it to the profile). */
const devtoolsPortOf = (profile) =>
  waitFor(() => Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]), "Chromium's DevToolsActivePort file");

/**
 * Launches Chromium with the extension and opens the real side panel. `allowed`: the profile starts
 * with the microphone allowed for the extension, stored exactly as Chrome stores the user's click on
 * Allow (the content setting media_stream_mic for the origin "chrome-extension://<id>/"; headless
 * Chromium writes the same entry with "block" when it refuses the prompt).
 */
async function launch({ allowed }) {
  const ext = await launchExtension({
    name: "voice-profile",
    prefs: allowed ? micAllowedPreferences(EXTENSION_ID) : undefined,
    args: ["--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${audioFile}`, "--remote-debugging-port=0"],
  });
  const { context, sw, extensionId, profile } = ext;
  const origin = `chrome-extension://${extensionId}`;
  // Open the real side panel from an extension page (not the panel itself, hence #opener).
  const opener = await context.newPage();
  await opener.goto(`${origin}/sidepanel.html#opener`);
  const windowId = await sw.evaluate(async () => (await chrome.windows.getLastFocused()).id);
  await openSidePanel(sw, opener, windowId);
  const devtoolsPort = await devtoolsPortOf(profile);
  const panel = await waitFor(() => cdpPage(devtoolsPort, "/sidepanel.html"), "the side panel's DevTools target");
  const close = async () => {
    panel.close();
    await ext.close();
  };
  return { context, origin, panel, close };
}

const permissionIn = (page) => page.evaluate(async () => (await navigator.permissions.query({ name: "microphone" })).state);
/** getUserMedia in `page`: "granted", the error, or "no answer" when it hangs. */
const tryMic = (page) =>
  page.evaluate(() =>
    Promise.race([
      navigator.mediaDevices.getUserMedia({ audio: true }).then(
        (s) => (s.getTracks().forEach((t) => t.stop()), "granted"),
        (e) => `${e.name}: ${e.message}`,
      ),
      new Promise((r) => setTimeout(() => r("no answer after 4 s (a prompt nobody can see)"), 4000)),
    ]),
  );
const pageState = async (page) => ({ state: await page.getAttribute("body", "data-state"), title: await page.textContent("#mic-title") });

const { step, finish } = createSuite("voice");

// 1. As Chrome behaves for a user who has not allowed the microphone yet.
{
  const { context, origin, panel, close } = await launch({ allowed: false });
  try {
    await step("before any grant the side panel's microphone permission is 'prompt'", async () => {
      assert.equal(await permissionIn(panel), "prompt");
      return "prompt";
    });
    await step("the side panel cannot ask for the microphone itself (Chrome shows no prompt there)", async () => {
      const r = await tryMic(panel);
      assert.notEqual(r, "granted");
      return r;
    });
    await step("mic-permission.html asks as soon as it opens (headless Chromium blocks the prompt)", async () => {
      const page = await context.newPage();
      await page.goto(`${origin}/mic-permission.html`);
      await waitFor(async () => (await pageState(page)).state !== "asking", "an answer to the prompt", { timeout: 8000 }).catch(() => null);
      return `the page shows ${JSON.stringify(await pageState(page))}`;
    });
  } finally {
    await close();
  }
}

// 2. After the user allowed the microphone on the permission page (the stored per-origin Allow).
{
  const { context, origin, panel, close } = await launch({ allowed: true });
  try {
    await step("the side panel sees the page's Allow and can open the microphone without a prompt", async () => {
      const state = await permissionIn(panel);
      const mic = await tryMic(panel);
      assert.equal(state, "granted");
      assert.equal(mic, "granted");
      return `state ${state}; getUserMedia ${mic}`;
    });

    await step("the permission page says the microphone is allowed", async () => {
      const page = await context.newPage();
      await page.goto(`${origin}/mic-permission.html`);
      await waitFor(async () => (await pageState(page)).state === "granted", "the granted state");
      return `${await page.textContent("#mic-title")}: ${await page.textContent("#mic-body")}`;
    });

    await step("the capture pipeline runs in the side panel: 16 kHz context, AudioWorklet, speech, live requests", async () => {
      await panel.evaluate(voiceBundle);
      const out = await panel.evaluate(
        async ({ wanted, timeoutMs }) => {
          const probe = new AudioContext({ sampleRate: 16000 });
          const ctxRate = probe.sampleRate;
          const worklet = typeof probe.audioWorklet?.addModule === "function";
          await probe.close();
          const { Dictation, MicSource } = globalThis.__voice;
          const requests = [];
          const states = [];
          let maxLevel = 0;
          let chunks = 0;
          const source = new MicSource();
          const start = source.start.bind(source);
          source.start = (onSamples) => start((s) => (chunks++, onSamples(s)));
          const t0 = performance.now();
          const d = new Dictation({
            source,
            transcribe: async (wav, req) => {
              requests.push({ atMs: Math.round(performance.now() - t0), seconds: (wav.byteLength - 44) / 32000, speechMs: req.speechMs });
              return `clip ${requests.length}`;
            },
            events: { onState: (s) => states.push(s), onLevel: (l) => (maxLevel = Math.max(maxLevel, l)) },
          });
          const done = d.run();
          // Listen until the live re-transcription has sent `wanted` requests (or the time is up).
          while (requests.length < wanted && performance.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 100));
          d.stop("send");
          const result = await done;
          return { ctxRate, worklet, states, maxLevel: +maxLevel.toFixed(2), chunks, requests, result };
        },
        { wanted: LIVE_REQUESTS, timeoutMs: LIVE_TIMEOUT_MS },
      );
      assert.equal(out.ctxRate, 16000);
      assert.ok(out.worklet, "AudioWorklet available");
      assert.ok(out.chunks > 50, `audio chunks: ${out.chunks}`);
      assert.ok(out.maxLevel > 0.3, `level ${out.maxLevel}`);
      assert.ok(out.requests.length >= LIVE_REQUESTS, JSON.stringify(out.requests));
      assert.deepEqual(out.states, ["listening", "transcribing", "done"]);
      return JSON.stringify(out);
    });
  } finally {
    await close();
  }
}
rmSync(scratch, { recursive: true, force: true });

finish();
