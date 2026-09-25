/**
 * Opens the options page, optionally on one of its tabs (options.html#ai).
 * An options tab that is already open is reused: only its hash changes, so
 * the page switches tabs without reloading.
 */
export async function openSettings(tab?: string): Promise<void> {
  if (!tab) return void chrome.runtime.openOptionsPage();
  try {
    const base = chrome.runtime.getURL("options.html");
    const url = `${base}#${tab}`;
    const open = (await chrome.tabs.query({})).find((t) => t.url?.startsWith(base));
    if (open?.id !== undefined) {
      await chrome.tabs.update(open.id, { url, active: true });
      if (open.windowId !== undefined) await chrome.windows.update(open.windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url });
    }
  } catch {
    await chrome.runtime.openOptionsPage();
  }
}
