# browsertodo

browsertodo works through a todo list in your own Chrome. On a timer, it takes
the next task from a task server and hands it to an AI agent that uses your
real, logged-in browser: it navigates, reads the page, clicks, types, pastes,
scrolls, takes screenshots and uploads images or video. It was built to catch
up on social posting, like three posts a day on each of three X accounts,
without launching a separate automation browser.

The agent is [Claude Code](https://claude.com/claude-code) running headless on
your machine. [Jev](https://typesafe.ai) can optionally pick elements for
simple steps, which makes them faster and cheaper.

## How it works

```
Task server  <── claim / heartbeat / result ──  Chrome extension (timer, browser control)
                                                        │ native messaging
                                                        ▼
                                                  Local helper ── runs `claude -p` per task
                                                        ▲               │
                                                        └── MCP tools ──┘
```

1. **The timer fires**, every 15 minutes by default.
2. **The extension claims the next due task** from your task server.
3. **The helper starts Claude Code** for that task. Claude Code can only use
   the browser tools: no shell and no file access.
4. **Each browser tool call runs in a dedicated Chrome window** through the
   Chrome debugger, so your own tabs are left alone.
5. **The result is reported** to the task server: done with the post URL,
   failed with a reason, or paused because it needs you.

Tasks pause instead of guessing when they reach a login page, 2FA, a CAPTCHA,
a locked account, or anything else unexpected. Chrome shows a notification,
and the task is retried later.

## Requirements

- Windows 10 or 11. The helper's installer uses the Windows registry.
- Google Chrome.
- Node.js 22 or newer, and pnpm 10.
- Claude Code, installed and signed in. Check that `claude --version` works.
- Optional: a Jev API key from TypeSafe.
- A task server that implements [the protocol](docs/PROTOCOL.md).

## Setup

1. **Build it.**

   ```
   pnpm install
   pnpm build
   ```

2. **Load the extension.** Open `chrome://extensions`, turn on Developer mode,
   click "Load unpacked", and pick the `dist` folder at the root of this
   repository. The extension ID is fixed by the key in its manifest, and is
   listed in `apps/extension/extension-id.txt`.

3. **Register the helper with Chrome.**

   ```
   node apps/helper/dist/install.js
   ```

   This registers the native messaging host `com.browsertodo.helper` for the
   extension ID above. Run it again with `--uninstall` to remove it.

4. **Optional: add your Jev key.** Copy `.env.example` to `.env` and fill in
   `TYPESAFE_API_KEY`. Without it, Claude does every step itself.

5. **Sign in to your accounts by hand** in Chrome. For several X accounts, use
   X's "Add an existing account" so all of them show in X's account switcher.
   browsertodo never types an X password. It switches between accounts that
   are already signed in.

6. **Configure the extension.** Open its options page. Enter your task
   server's URL and runner key, then click "Test API connection" and "Connect
   helper". The options page also shows a live log of what the agent is doing.

## Writing tasks

A task is plain-language instructions, plus an optional account, media files
and an earliest start time:

```json
{
  "instructions": "Post this on X: Good morning! Today's tip: ...",
  "account": "@myhandle",
  "mediaIds": ["<id of an uploaded image>"],
  "notBefore": "2026-09-24T09:00:00Z"
}
```

## Settings

| Setting | Default |
|---|---|
| Run interval | 15 minutes |
| Random pause between tasks | 60–180 seconds |
| Maximum tool calls per task | 60 |
| Maximum time per task | 10 minutes |
| Jev confidence threshold | 0.8 |
| Retry a paused task after | 15 minutes |

The helper reads these environment variables, from the environment or a `.env`
file in the repository root:

| Variable | Purpose |
|---|---|
| `TYPESAFE_API_KEY` | Jev key. Leave empty to turn Jev off. |
| `BROWSERTODO_MODEL` | Claude model alias for tasks. Default `sonnet`. |
| `BROWSERTODO_CLAUDE_PATH` | Path to `claude.exe` if it isn't found automatically. |
| `BROWSERTODO_HOME` | Where logs and run folders go. Default `%LOCALAPPDATA%\browsertodo`. |

Each task's full log, including every tool call, Jev decision and Claude
message, is written to `%LOCALAPPDATA%\browsertodo\runs\<task>\log.jsonl`.

## Things to know

- **Chrome shows an "is debugging this browser" bar** while a task runs. That
  bar is how the extension sends real clicks and keystrokes, and it can't be
  hidden.
- **Sites can change their pages.** Account switching on X relies on X's
  current markup. If it breaks, Claude falls back to finding the menu itself.
- **Automation may break a site's rules.** Check the terms of any site you
  automate. Pacing between tasks is on by default.
- **Page content is untrusted.** The agent is told to follow only your task's
  instructions, never instructions it finds on a web page.

## Development

```
pnpm test        # unit and integration tests
pnpm typecheck
node apps/extension/test/smoke.e2e.mjs   # loads the built extension in Playwright's Chromium
```

`test/fixtures/fake-x` is a small fake X site, with an account switcher, a
composer, image upload and a lock page, for testing the whole pipeline without
touching the real site.

## License

MIT
