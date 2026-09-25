/** The options page's Test buttons. Each resolves { ok, detail } and never throws. */
import { ANTHROPIC_API_BASE, ANTHROPIC_API_VERSION, errorMessage, type ExtensionSettings, type PageSnapshot } from "@browsertodo/shared";
import type { CoreApi } from "./brains.js";

export interface TestResult {
  ok: boolean;
  detail: string;
}

export const ANTHROPIC_MODELS_URL = `${ANTHROPIC_API_BASE}/models`;

/** GET /v1/models with the stored key: proves the key works without spending tokens. */
export async function testClaude(settings: ExtensionSettings, fetchFn: typeof fetch = (i, init) => fetch(i, init)): Promise<TestResult> {
  if (!settings.anthropicApiKey) return { ok: false, detail: "No Claude API key set" };
  let res: Response;
  try {
    res = await fetchFn(ANTHROPIC_MODELS_URL, {
      method: "GET",
      headers: {
        "x-api-key": settings.anthropicApiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
      },
    });
  } catch (err) {
    return { ok: false, detail: `Cannot reach ${new URL(ANTHROPIC_API_BASE).host}: ${errorMessage(err)}` };
  }
  const body = (await res.json().catch(() => null)) as { data?: { id?: string }[]; error?: { message?: string } } | null;
  if (res.status === 401 || res.status === 403) return { ok: false, detail: `Claude API key rejected (HTTP ${res.status})` };
  if (!res.ok) return { ok: false, detail: `Claude API answered HTTP ${res.status}${body?.error?.message ? `: ${body.error.message}` : ""}` };
  const ids = (body?.data ?? []).map((m) => m.id).filter((x): x is string => !!x);
  const model = settings.anthropicModel;
  const modelNote = ids.length === 0 ? "" : ids.includes(model) ? `; model ${model} is available` : `; model ${model} is not in the list for this key`;
  return { ok: true, detail: `Key accepted${ids.length ? ` (${ids.length} models)` : ""}${modelNote}` };
}

const TEST_SNAPSHOT: PageSnapshot = {
  url: "https://example.com/form",
  title: "Test form",
  text: "Newsletter. Enter your email and press Subscribe.",
  elements: [
    { index: 0, tag: "input", role: "textbox", name: "Email", type: "email", inViewport: true },
    { index: 1, tag: "button", role: "button", name: "Subscribe", inViewport: true },
  ],
  truncated: false,
};

/** One tiny Jev decision on a two-element page. */
export async function testJev(settings: ExtensionSettings, core: Pick<CoreApi, "createJev">, fetchFn?: typeof fetch): Promise<TestResult> {
  if (!settings.jevApiKey) return { ok: false, detail: "No Jev key set" };
  const started = Date.now();
  try {
    const jev = core.createJev(settings.jevApiKey, fetchFn ? { fetch: fetchFn } : undefined);
    const d = await jev.decide({ goal: "click the Subscribe button", snapshot: TEST_SNAPSHOT });
    const ms = Date.now() - started;
    const target = d.index === null ? "no element" : `element ${d.index}`;
    const right = d.operation === "click" && d.index === 1;
    return {
      ok: true,
      detail: `Jev answered in ${ms} ms: ${d.operation} ${target} (confidence ${d.confidence.toFixed(2)})${right ? "" : " (unexpected choice)"}`,
    };
  } catch (err) {
    return { ok: false, detail: `Jev test failed: ${errorMessage(err)}` };
  }
}

/** Reachability and runner key check against the cloud API. */
export async function testCloud(
  settings: ExtensionSettings,
  check: (s: ExtensionSettings) => Promise<{ ok: true } | { ok: false; error: string }>,
): Promise<TestResult> {
  if (!settings.apiBase) return { ok: false, detail: "Cloud API URL is not set" };
  if (!settings.runnerKey) return { ok: false, detail: "Runner key is not set" };
  try {
    const r = await check(settings);
    return r.ok ? { ok: true, detail: `Connected to ${settings.apiBase}` } : { ok: false, detail: r.error };
  } catch (err) {
    return { ok: false, detail: errorMessage(err) };
  }
}
