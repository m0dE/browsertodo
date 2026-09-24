/**
 * Encrypted credential store for non-X sites.
 * AES-GCM 256 with a key from PBKDF2-SHA256 over the passphrase. The derived
 * raw key lives in chrome.storage.session, so it survives service worker
 * restarts but not a browser restart.
 */

const VAULT_KEY = "vault";
const SESSION_KEY = "vaultKey";
const VERIFIER_TEXT = "browsertodo-vault-v1";

interface Sealed {
  iv: string;
  data: string;
}

interface VaultData {
  salt: string;
  verifier: Sealed;
  entries: Record<string, Sealed>;
}

export type CredentialResult = { found: false; locked?: boolean } | { found: true; username: string; password: string };

export class Vault {
  readonly iterations: number;

  constructor(opts: { iterations?: number } = {}) {
    this.iterations = opts.iterations ?? 310000;
  }

  /** Unlock with the passphrase, creating the vault on first use. */
  async unlock(passphrase: string): Promise<void> {
    if (!passphrase) throw new Error("Passphrase is empty");
    let data = await this.read();
    let key: CryptoKey;
    if (!data) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      key = await this.derive(passphrase, salt);
      data = { salt: toB64(salt), verifier: await seal(key, VERIFIER_TEXT), entries: {} };
      await chrome.storage.local.set({ [VAULT_KEY]: data });
    } else {
      key = await this.derive(passphrase, fromB64(data.salt));
      const check = await open(key, data.verifier).catch(() => null);
      if (check !== VERIFIER_TEXT) throw new Error("Wrong passphrase");
    }
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
    await chrome.storage.session.set({ [SESSION_KEY]: toB64(raw) });
  }

  async lock(): Promise<void> {
    await chrome.storage.session.remove(SESSION_KEY);
  }

  async list(): Promise<{ locked: boolean; sites: string[] }> {
    const data = await this.read();
    const locked = (await this.sessionKey()) === null;
    return { locked, sites: Object.keys(data?.entries ?? {}).sort() };
  }

  async set(site: string, username: string, password: string): Promise<void> {
    const key = await this.requireKey();
    const data = (await this.read())!;
    const host = normalizeSite(site);
    if (!host) throw new Error("Site is empty");
    data.entries[host] = await seal(key, JSON.stringify({ username, password }));
    await chrome.storage.local.set({ [VAULT_KEY]: data });
  }

  async delete(site: string): Promise<void> {
    const data = await this.read();
    if (!data) return;
    delete data.entries[normalizeSite(site)];
    await chrome.storage.local.set({ [VAULT_KEY]: data });
  }

  /** Exact hostname first, then each parent domain. */
  async getCredential(site: string): Promise<CredentialResult> {
    const key = await this.sessionKey();
    if (!key) return { found: false, locked: true };
    const data = await this.read();
    if (!data) return { found: false };
    const labels = normalizeSite(site).split(".");
    for (let i = 0; i < labels.length; i++) {
      const entry = data.entries[labels.slice(i).join(".")];
      if (!entry) continue;
      const { username, password } = JSON.parse(await open(key, entry)) as { username: string; password: string };
      return { found: true, username, password };
    }
    return { found: false };
  }

  private async read(): Promise<VaultData | null> {
    const got = await chrome.storage.local.get(VAULT_KEY);
    return (got[VAULT_KEY] as VaultData | undefined) ?? null;
  }

  private async sessionKey(): Promise<CryptoKey | null> {
    const got = await chrome.storage.session.get(SESSION_KEY);
    const raw = got[SESSION_KEY];
    if (typeof raw !== "string") return null;
    return crypto.subtle.importKey("raw", fromB64(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
  }

  private async requireKey(): Promise<CryptoKey> {
    const key = await this.sessionKey();
    if (!key) throw new Error("Vault is locked");
    return key;
  }

  private async derive(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: this.iterations },
      base,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
  }
}

/** "https://Mail.Example.com/x" or "mail.example.com" -> "mail.example.com". */
export function normalizeSite(site: string): string {
  const s = site.trim().toLowerCase();
  try {
    if (s.includes("://")) return new URL(s).hostname.replace(/\.$/, "");
  } catch {
    /* fall through */
  }
  return s.replace(/\/.*$/, "").replace(/:\d+$/, "").replace(/\.$/, "");
}

async function seal(key: CryptoKey, text: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text));
  return { iv: toB64(iv), data: toB64(new Uint8Array(data)) };
}

async function open(key: CryptoKey, sealed: Sealed): Promise<string> {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(sealed.iv) }, key, fromB64(sealed.data));
  return new TextDecoder().decode(plain);
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
