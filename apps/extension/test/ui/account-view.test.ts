import { describe, expect, it } from "vitest";
import { accountSummary, billingReturnUrl, dateLabel, planChoices } from "../../src/options/account-view.js";
import type { AccountView } from "../../src/ui-protocol.js";

const base: AccountView = { signedIn: true, signInConfigured: true, apiBase: "https://api.test", dashboardUrl: "https://api.test/", user: { email: "a@b.c", name: null, pictureUrl: null } };

describe("options: account summary", () => {
  it("free plan without billing on the server", () => {
    const s = accountSummary({
      ...base,
      plan: { id: "free", status: "none", currentPeriodEnd: null, cancelAtPeriodEnd: false },
      credit: { subscriptionCents: 0, topupCents: 0, totalCents: 0, periodGrantCents: 0, periodEnd: null },
      stripeConfigured: false,
    });
    expect(s).toMatchObject({ planName: "Free", planStatus: "", credit: "$0.00", creditDetail: "$0.00 top-up", paid: false, keysAllowed: false, billing: "not-set-up" });
    // What Free lacks, from the plan catalog: the TODO list first.
    expect(s.planIncludes).toBe("No TODO list, voice input or API keys");
  });

  it("paid plan: renewal date, subscription credit with its expiry plus top-up, keys allowed", () => {
    const s = accountSummary({
      ...base,
      plan: { id: "plus", status: "active", currentPeriodEnd: "2026-10-24T00:00:00Z", cancelAtPeriodEnd: false },
      credit: { subscriptionCents: 1540, topupCents: 1000, totalCents: 2540, periodGrantCents: 2000, periodEnd: "2026-10-24T00:00:00Z" },
      stripeConfigured: true,
    });
    expect(s).toMatchObject({
      planName: "Plus",
      planStatus: "Renews Oct 24, 2026",
      credit: "$25.40",
      creditDetail: "$15.40 subscription (expires Oct 24, 2026) + $10.00 top-up",
      paid: true,
      keysAllowed: true,
      billing: "ready",
      planIncludes: "Includes TODO list, voice input and API keys",
    });
    expect(accountSummary({ ...base, plan: { id: "pro", status: "active", currentPeriodEnd: "2026-10-24T00:00:00Z", cancelAtPeriodEnd: true } }).planStatus).toBe("Ends Oct 24, 2026");
    expect(accountSummary({ ...base, plan: { id: "starter", status: "past_due", currentPeriodEnd: null, cancelAtPeriodEnd: false } })).toMatchObject({ planStatus: "Payment overdue", paid: true });
    expect(accountSummary({ ...base, plan: { id: "free", status: "canceled", currentPeriodEnd: null, cancelAtPeriodEnd: false } })).toMatchObject({ planName: "Free", planStatus: "Subscription ended", paid: false, keysAllowed: false });
  });

  it("unknown billing and out of credit", () => {
    expect(accountSummary(base)).toMatchObject({ billing: "unknown", credit: "", planName: "Free", planIncludes: "" });
    expect(accountSummary({ ...base, outOfCredit: { topupUrl: "u" } }).outOfCredit).toBe(true);
  });

  it("plan choices, dates and the return URL", () => {
    expect(planChoices()).toEqual([
      { id: "starter", label: "Starter", detail: "$9.99/mo · $5.00 usage credit", includes: "Includes TODO list, voice input and API keys" },
      { id: "plus", label: "Plus", detail: "$29.99/mo · $20.00 usage credit", includes: "Includes TODO list, voice input and API keys" },
      { id: "pro", label: "Pro", detail: "$199.99/mo · $199.99 usage credit", includes: "Includes TODO list, voice input and API keys" },
    ]);
    expect(dateLabel("bogus")).toBe("");
    expect(billingReturnUrl("https://api.test/")).toBe("https://api.test/billing");
    expect(billingReturnUrl("")).toBe("");
  });
});
