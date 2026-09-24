/** Show a Chrome notification with the extension icon. Never throws. */
export async function notify(title: string, message: string): Promise<void> {
  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: `browsertodo: ${title}`,
      message: message.slice(0, 500),
      priority: 1,
    });
  } catch (err) {
    console.warn("notification failed", err);
  }
}
