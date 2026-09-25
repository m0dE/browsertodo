import { beforeEach, describe, expect, it } from "vitest";
import { installChromeFake, type ChromeFake } from "./chrome-fake.js";
import { Vault } from "../src/vault.js";

let chrome: ChromeFake;
let vault: Vault;
beforeEach(() => {
  chrome = installChromeFake();
  vault = new Vault({ iterations: 1000 });
});

describe("vault", () => {
  it("starts locked and empty", async () => {
    expect(await vault.list()).toEqual({ locked: true, sites: [] });
    // Nothing saved yet: "not found", never "locked" (nothing to unlock).
    expect(await vault.getCredential("example.com")).toEqual({ found: false });
  });

  it("round-trips a credential after unlock, stored encrypted", async () => {
    await vault.unlock("correct horse");
    await vault.set("Example.com", "alice", "s3cret");
    expect(await vault.getCredential("example.com")).toEqual({ found: true, username: "alice", password: "s3cret" });
    expect(await vault.list()).toEqual({ locked: false, sites: ["example.com"] });

    const raw = JSON.stringify(chrome.storage.local.data.vault);
    expect(raw).not.toContain("s3cret");
    expect(raw).not.toContain("alice");
    expect(typeof chrome.storage.session.data.vaultKey).toBe("string");
  });

  it("uses the real PBKDF2 iteration count by default", () => {
    expect(new Vault().iterations).toBe(310000);
  });

  it("rejects a wrong passphrase and stays locked", async () => {
    await vault.unlock("right");
    await vault.set("example.com", "a", "b");
    await vault.lock();
    await expect(vault.unlock("wrong")).rejects.toThrow(/wrong passphrase/i);
    expect((await vault.list()).locked).toBe(true);
    // Logins saved and locked: this is the one case that reports "locked".
    expect(await vault.getCredential("example.com")).toEqual({ found: false, locked: true });
    await vault.unlock("right");
    expect(await vault.getCredential("example.com")).toMatchObject({ found: true, password: "b" });
  });

  it("matches the exact host first, then parent domains", async () => {
    await vault.unlock("pw");
    await vault.set("example.com", "root", "1");
    await vault.set("mail.example.com", "mail", "2");
    expect(await vault.getCredential("mail.example.com")).toMatchObject({ username: "mail" });
    expect(await vault.getCredential("a.b.example.com")).toMatchObject({ username: "root" });
    expect(await vault.getCredential("https://login.example.com/path")).toMatchObject({ username: "root" });
    expect(await vault.getCredential("other.com")).toEqual({ found: false });
  });

  it("returns locked after lock and survives a new instance (worker restart)", async () => {
    await vault.unlock("pw");
    await vault.set("example.com", "u", "p");
    const again = new Vault({ iterations: 1000 });
    expect(await again.getCredential("example.com")).toMatchObject({ found: true, username: "u" });
    await again.lock();
    expect(await vault.getCredential("example.com")).toEqual({ found: false, locked: true });
  });

  it("deletes entries and refuses writes while locked", async () => {
    await vault.unlock("pw");
    await vault.set("example.com", "u", "p");
    await vault.delete("example.com");
    expect((await vault.list()).sites).toEqual([]);
    await vault.lock();
    await expect(vault.set("x.org", "u", "p")).rejects.toThrow(/locked/i);
  });
});
