/** Options page: the "Site logins" section (encrypted vault used by get_credential). */
import { uiRequest } from "../ui-protocol.js";
import { $, busy, flash, h, showError } from "../ui/dom.js";

export function initVaultSection(): void {
  const locked = $("vault-locked");
  const open = $("vault-open");
  const list = $("vault-sites");
  const msg = $("vault-msg");
  const pass = $<HTMLInputElement>("vault-pass");
  const site = $<HTMLInputElement>("vault-site");
  const user = $<HTMLInputElement>("vault-user");
  const pw = $<HTMLInputElement>("vault-pw");

  async function refresh(): Promise<void> {
    const v = await uiRequest({ type: "vault.list" });
    locked.hidden = !v.locked;
    open.hidden = v.locked;
    list.replaceChildren(
      ...(v.sites.length
        ? v.sites.map((s) => {
            const del = h("button.small", { type: "button" }, "Remove");
            del.addEventListener("click", () =>
              void busy(
                del,
                async () => {
                  await uiRequest({ type: "vault.delete", site: s });
                  flash(msg, `Removed ${s}.`, "ok");
                  await refresh();
                },
                msg,
              ),
            );
            return h("li", {}, h("span", {}, s), del);
          })
        : [h("li", { class: "empty" }, v.locked ? "" : "No saved logins yet.")]),
    );
  }

  const unlock = $<HTMLButtonElement>("vault-unlock");
  const doUnlock = () =>
    void busy(
      unlock,
      async () => {
        await uiRequest({ type: "vault.unlock", passphrase: pass.value });
        pass.value = "";
        flash(msg, "Unlocked.", "ok");
        await refresh();
      },
      msg,
    );
  unlock.addEventListener("click", doUnlock);
  pass.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doUnlock();
    }
  });

  const add = $<HTMLButtonElement>("vault-add");
  add.addEventListener("click", () =>
    void busy(
      add,
      async () => {
        if (!site.value.trim() || !user.value || !pw.value) return flash(msg, "Fill in site, username and password.", "bad");
        await uiRequest({ type: "vault.set", site: site.value.trim(), username: user.value, password: pw.value });
        flash(msg, `Saved the login for ${site.value.trim()}.`, "ok");
        site.value = user.value = pw.value = "";
        await refresh();
      },
      msg,
    ),
  );

  const lock = $<HTMLButtonElement>("vault-lock");
  lock.addEventListener("click", () =>
    void busy(
      lock,
      async () => {
        await uiRequest({ type: "vault.lock" });
        flash(msg, "Locked.", "ok");
        await refresh();
      },
      msg,
    ),
  );

  void refresh().catch((err: unknown) => showError(msg, err));
}
