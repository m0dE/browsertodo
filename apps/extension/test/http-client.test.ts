import { describe, expect, it, vi } from "vitest";
import { ApiRequestError, HttpClient, NotSignedInError } from "../src/http-client.js";

const answer = (status: number, body: string) => vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;

describe("HttpClient", () => {
  it("takes the server's words: message before error, never a bare code; keeps the body", async () => {
    const body = { error: "plan_required", message: "API keys need a paid plan.", upgradeUrl: "https://dash.test/billing" };
    const http = new HttpClient({ apiBase: "https://api.test", token: "t", missingBase: "no base", fetch: answer(403, JSON.stringify(body)) });
    const err = (await http.request("POST", "/v1/me/keys", {}).catch((e: unknown) => e)) as ApiRequestError;
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({ status: 403, message: "API keys need a paid plan.", body });
    const bare = new HttpClient({ apiBase: "https://api.test", token: "t", missingBase: "no base", fetch: answer(402, JSON.stringify({ error: "out_of_credit" })) });
    await expect(bare.request("GET", "/x")).rejects.toThrow("HTTP 402");
  });

  it("raw error text, a label, 401 and a missing token or base", async () => {
    const onUnauthorized = vi.fn();
    const http = new HttpClient({ apiBase: "https://api.test", token: "t", missingBase: "no base", label: "API", onUnauthorized, fetch: answer(401, "nope") });
    await expect(http.request("GET", "/x")).rejects.toThrow("API 401: nope");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    await expect(http.request("GET", "/x", undefined, { auth: false })).rejects.toThrow("API 401: nope");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    await expect(new HttpClient({ apiBase: "https://api.test", missingBase: "no base" }).request("GET", "/x")).rejects.toBeInstanceOf(NotSignedInError);
    await expect(new HttpClient({ apiBase: "", missingBase: "no base" }).request("GET", "/x")).rejects.toThrow("no base");
  });
});
