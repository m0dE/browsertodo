// Fake X site for end-to-end tests. Serves HTTPS on 127.0.0.1 so Chromium can
// load it as https://x.com via --host-resolver-rules and
// --ignore-certificate-errors. Mimics the parts of X the agent touches: the
// account switcher, the inline composer with a hidden file input, the Post
// button, and a lock page. The data-testid values mirror X's markup as of
// 2026 and must be re-checked against the live site.
//
// Usage: node test/fixtures/fake-x/server.mjs [--port 443]
// API:   GET /api/feed  -> { "@alpha": [...], ... }   POST /api/reset

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ACCOUNTS = [
  { handle: "@alpha", name: "Alpha" },
  { handle: "@beta", name: "Beta" },
  { handle: "@gamma", name: "Gamma" },
  { handle: "@locked", name: "Locked" },
];

function ensureCert() {
  const dir = join(tmpdir(), "browsertodo-fake-x");
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  if (!existsSync(key) || !existsSync(cert)) {
    mkdirSync(dir, { recursive: true });
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30",
      "-keyout", key, "-out", cert, "-subj", "/CN=x.com",
      "-addext", "subjectAltName=DNS:x.com,DNS:twitter.com,IP:127.0.0.1",
    ], { stdio: "ignore", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function currentAccount(req) {
  const m = /(?:^|;\s*)acct=([^;]+)/.exec(req.headers.cookie ?? "");
  const handle = m ? decodeURIComponent(m[1]) : "@alpha";
  return ACCOUNTS.find((a) => a.handle === handle) ?? ACCOUNTS[0];
}

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
body{font-family:system-ui;margin:0;display:flex}
nav{width:240px;padding:16px;border-right:1px solid #ddd;min-height:100vh;box-sizing:border-box;position:relative}
main{flex:1;padding:16px;max-width:600px}
#menu{position:absolute;bottom:80px;left:16px;background:#fff;border:1px solid #ccc;padding:8px;display:none}
#menu a{display:block;padding:6px}
[contenteditable]{border:1px solid #ccc;min-height:60px;padding:8px}
.acct-btn{position:absolute;bottom:16px;left:16px}
.post{border-bottom:1px solid #eee;padding:8px 0}
</style></head><body>${body}</body></html>`;
}

function nav(acct) {
  const items = ACCOUNTS.filter((a) => a.handle !== acct.handle)
    .map((a) => `<a role="menuitem" href="/i/switch?to=${encodeURIComponent(a.handle)}">Switch to ${esc(a.name)} ${esc(a.handle)}</a>`)
    .join("");
  return `<nav>
  <a href="/home" data-testid="AppTabBar_Home_Link">Home</a><br>
  <a href="/compose/post" data-testid="SideNav_NewTweet_Button" role="link">Post</a>
  <div id="menu" role="menu">${items}<a role="menuitem" href="/i/flow/login">Add an existing account</a></div>
  <button class="acct-btn" data-testid="SideNav_AccountSwitcher_Button" aria-label="Account menu"
    onclick="var m=document.getElementById('menu');m.style.display=m.style.display==='block'?'none':'block'">
    ${esc(acct.name)} ${esc(acct.handle)}</button>
</nav>`;
}

function home(acct, feed) {
  const posts = (feed[acct.handle] ?? [])
    .slice().reverse()
    .map((p) => `<div class="post"><a href="/${acct.handle.slice(1)}/status/${p.id}">${esc(p.text)}</a>${p.media.length ? ` [${p.media.length} media]` : ""}</div>`)
    .join("");
  return page("Home / X", `${nav(acct)}<main>
  <h1>Home</h1>
  <div data-testid="primaryColumn">
    <div contenteditable="true" role="textbox" aria-label="Post text" data-testid="tweetTextarea_0" id="editor"></div>
    <input type="file" data-testid="fileInput" id="file" multiple accept="image/*,video/*" style="display:none">
    <div id="attachments" data-testid="attachments"></div>
    <button data-testid="tweetButtonInline" id="post" disabled>Post</button>
  </div>
  <div id="toast" role="alert" data-testid="toast" style="display:none"></div>
  <h2>Your posts</h2><div id="feed">${posts}</div>
</main>
<script>
const editor = document.getElementById('editor');
const btn = document.getElementById('post');
const file = document.getElementById('file');
const att = document.getElementById('attachments');
function sync(){ btn.disabled = editor.innerText.trim().length === 0; }
editor.addEventListener('input', sync);
file.addEventListener('change', () => {
  att.textContent = Array.from(file.files).map(f => f.name + ' (' + f.size + ' bytes)').join(', ');
});
btn.addEventListener('click', async () => {
  const media = Array.from(file.files).map(f => ({ name: f.name, size: f.size, type: f.type }));
  const res = await fetch('/api/post', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: editor.innerText.trim(), media }) });
  const { url } = await res.json();
  // Like X: stay on the page, clear the composer, show a toast with a View link.
  editor.innerHTML = '';
  file.value = '';
  att.textContent = '';
  sync();
  const toast = document.getElementById('toast');
  toast.innerHTML = 'Your post was sent. <a href="' + url + '">View</a>';
  toast.style.display = 'block';
});
</script>`);
}

export function createFakeX() {
  let feed = {};
  let nextId = 1000;

  const handler = (req, res) => {
    const url = new URL(req.url, "https://x.com");
    const acct = currentAccount(req);
    const send = (status, body, type = "text/html; charset=utf-8", headers = {}) => {
      res.writeHead(status, { "content-type": type, ...headers });
      res.end(body);
    };
    const json = (status, obj) => send(status, JSON.stringify(obj), "application/json");

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/home" || url.pathname === "/compose/post")) {
      return send(200, home(acct, feed));
    }
    if (req.method === "GET" && url.pathname === "/i/switch") {
      const to = url.searchParams.get("to") ?? "@alpha";
      const cookie = `acct=${encodeURIComponent(to)}; Path=/; SameSite=Lax; Secure`;
      const location = to === "@locked" ? "/account/access" : "/home";
      return send(302, "", "text/plain", { location, "set-cookie": cookie });
    }
    if (req.method === "GET" && url.pathname === "/account/access") {
      return send(200, page("Your account is locked / X", `<main><h1>Your account has been locked</h1><p>Verify your identity.</p></main>`));
    }
    if (req.method === "GET" && url.pathname.startsWith("/i/flow/login")) {
      return send(200, page("Log in to X / X", `<main><h1>Sign in to X</h1><input aria-label="Phone, email, or username"></main>`));
    }
    const profile = /^\/([A-Za-z0-9_]+)$/.exec(url.pathname);
    if (req.method === "GET" && profile && ACCOUNTS.some((a) => a.handle === `@${profile[1]}`)) {
      const handle = `@${profile[1]}`;
      const posts = (feed[handle] ?? []).slice().reverse()
        .map((p) => `<article data-testid="tweet"><p>${esc(p.text)}</p><a href="/${profile[1]}/status/${p.id}"><time datetime="${p.at}">${p.at}</time></a></article>`)
        .join("");
      return send(200, page(`${handle} / X`, `${nav(acct)}<main><h1>${esc(handle)}</h1>${posts || "<p>No posts yet</p>"}</main>`));
    }
    const status = /^\/([A-Za-z0-9_]+)\/status\/(\d+)$/.exec(url.pathname);
    if (req.method === "GET" && status) {
      const post = Object.values(feed).flat().find((p) => String(p.id) === status[2]);
      if (!post) return send(404, page("Not found / X", "<main>Not found</main>"));
      return send(200, page(`${post.account} on X`, `${nav(acct)}<main><article data-testid="tweet"><b>${esc(post.account)}</b><p>${esc(post.text)}</p><p>${post.media.map((m) => esc(m.name)).join(", ")}</p></article></main>`));
    }
    if (req.method === "POST" && url.pathname === "/api/post") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { text, media } = JSON.parse(body || "{}");
        const id = nextId++;
        const post = { id, account: acct.handle, text, media: media ?? [], at: new Date().toISOString() };
        (feed[acct.handle] ??= []).push(post);
        json(200, { id, url: `/${acct.handle.slice(1)}/status/${id}` });
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/feed") return json(200, feed);
    if (req.method === "POST" && url.pathname === "/api/reset") {
      feed = {};
      return json(200, { ok: true });
    }
    send(404, page("Not found / X", "<main>Page not found</main>"));
  };

  const server = https.createServer(ensureCert(), handler);
  return {
    server,
    listen: (port = 443, host = "127.0.0.1") => new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(() => resolve())),
    feed: () => feed,
  };
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("server.mjs")) {
  const portArg = process.argv.indexOf("--port");
  const port = portArg > -1 ? Number(process.argv[portArg + 1]) : 443;
  const fx = createFakeX();
  fx.listen(port).then((p) => process.stderr.write(`fake X listening on https://127.0.0.1:${p}\n`));
}
