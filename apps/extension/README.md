# browsertodo extension

## Google sign-in (Log In)

The TODO tab's **Log In** uses `chrome.identity.launchWebAuthFlow` with a Google
OAuth **Web application** client. The client ID is baked in at build time:

```sh
# either
BROWSERTODO_GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com pnpm --filter @browsertodo/extension build
# or put it in apps/extension/config.json (gitignored; see config.example.json)
{ "googleClientId": "1234567890-abc.apps.googleusercontent.com" }
```

Without it, Log In asks the account server for its client ID (`GET /v1/config`,
the API's first `GOOGLE_CLIENT_ID`), and says so plainly when the server has
none. Either way the client needs the
redirect URI `https://<extension id>.chromiumapp.org/` (the ID is in
`extension-id.txt`), and the account server must accept the same client ID
(`GOOGLE_CLIENT_ID`, see `apps/api/README.md`).

The account server defaults to `https://app.browsertodo.com`.
Self-hosters can change it in Settings > Self-hosting > Account server URL.
The runner-key cloud sync stays there as well, for servers without accounts.
