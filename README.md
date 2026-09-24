# browsertodo

browsertodo is like Claude Code, for your browser. Give it a todo list and it
works through each task in your own logged-in Chrome: it navigates, reads the
page, clicks, types, scrolls, takes screenshots and uploads images or video,
then reports back. It was built to catch up on social posting, like three
posts a day on each of three X accounts, and it works for anything else you
do in Chrome.

It runs entirely on your machine. A cloud task queue is optional.

## What you get

- **A side panel** (click the toolbar icon) with three tabs:
  - **Tasks:** "Do this now", plus a todo list with times, daily repeats and
    attached files.
  - **Activity:** every step of the running task, live. You can type to the
    agent mid-task or stop it.
  - **Terminal:** your real Claude Code, running in the panel with
    browsertodo's browser tools attached.
- **A settings page** for choosing the brain, adding keys, cloud sync, and
  site logins.
- **Careful defaults:**
  - It pauses at login pages, 2FA, CAPTCHAs and account warnings.
  - It never types your X password.
  - It checks each post exists before calling the task done.
  - A retry after a crash checks for an existing post before posting again.
  - It stops running tasks after repeated failures.

## Choose a brain

| Option | You need | Notes |
|---|---|---|
| **Claude API** | An Anthropic API key | Runs inside the extension. Nothing else to install. |
| **Local Claude Code** | Claude Code installed and signed in, plus the helper below | Uses your Claude subscription. Also powers the Terminal tab. |
| **Auto** (default) | Either of the above | Uses local Claude Code when the helper works, otherwise the API key. |

**Jev is optional with either brain.** With a Jev key, steps can be described
in plain words ("click the Post button") and a small, fast model finds the
element. Without it, Claude names the element itself. Either way, Claude does
several steps per turn, which is where most of the speed comes from.

## Setup

Requirements: Windows 10 or 11 for the helper, Google Chrome, Node.js 22+ and
pnpm 10.

1. **Build it.**

   ```
   pnpm install
   pnpm build
   ```

2. **Load the extension.** Open `chrome://extensions`, turn on Developer mode,
   click "Load unpacked", and pick the `dist` folder at the root of this
   repository.

3. **Pick a brain** in the extension's settings: paste an Anthropic API key,
   or register the helper for local Claude Code:

   ```
   node apps/helper/dist/install.js
   ```

   Then click "Re-check" under the helper status. `--uninstall` removes the
   registration.

4. **Optional:** add a Jev key in settings.

5. **Sign in to your accounts by hand** in Chrome. For several X accounts, use
   X's "Add an existing account" so they all appear in X's account switcher.

6. **Add a task** in the side panel and click Run.

## Use the browser tools from your own terminal

With the helper registered and Chrome open, your regular Claude Code can drive
the browser too:

```
claude mcp add browsertodo -- node <path-to-repo>/apps/helper/dist/mcp-server.js --attach
```

Then ask Claude Code something like "post this on X from @me".

## Cloud task queue (optional)

Turn on Cloud sync in settings and enter a task server URL and runner key.
The extension then also takes tasks from that server, so another app can
queue work while your computer is off. Any server that implements
[the protocol](docs/PROTOCOL.md) works.

## Settings

| Setting | Default |
|---|---|
| Check for due tasks | every 15 minutes |
| Random pause between tasks | 60–180 seconds |
| Maximum tool calls per task | 60 |
| Maximum time per task | 10 minutes |
| Retry a temporary failure after | 10 minutes |
| Pause runs after failures in a row | 3 |

Logs of every run are in `%LOCALAPPDATA%\browsertodo\runs\` when the helper is
used, and in the Activity tab for both brains.

## Things to know

- **Chrome shows an "is debugging this browser" bar** while a task runs. That
  is how the extension sends real clicks and keystrokes.
- **Tasks run in their own window,** in a tab group named "browsertodo", so
  your tabs are left alone.
- **Sites change their pages.** Account switching on X relies on X's current
  markup. If it breaks, Claude falls back to finding the menu itself.
- **Automation may break a site's rules.** Check the terms of any site you
  automate.
- **Page content is untrusted.** The agent follows your instructions, not text
  it finds on a page.

## Development

```
pnpm test
pnpm typecheck
node apps/extension/test/smoke.e2e.mjs   # the built extension in Playwright's Chromium
```

`test/fixtures/fake-x` is a small fake X site, with an account switcher, a
composer, image upload and a lock page, for testing without touching the
real site.

Not affiliated with Anthropic, X or TypeSafe. Claude and Claude Code are
trademarks of Anthropic.

## License

MIT
