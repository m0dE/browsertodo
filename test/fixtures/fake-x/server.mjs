// Fake X site for end-to-end tests. Serves HTTPS on 127.0.0.1 so Chromium can
// load it as https://x.com via --host-resolver-rules and
// --ignore-certificate-errors. Mimics the parts of X the agent touches: the
// account switcher, the inline composer with a hidden file input, the Post
// button, and a lock page. The data-testid values mirror X's HTML as of
// 2026 and must be re-checked against the live site.
// Like the real X: the account menu keeps the other accounts in a collapsed
// "Personal accounts" section, a profile of another account has a
// "Follow back @handle" button (it follows), and a post URL naming the wrong
// handle redirects to its author's.
//
// Usage: node test/fixtures/fake-x/server.mjs [--port 443]
// API:   GET /api/feed  -> { "@alpha": [...], ... }   POST /api/reset
// Also a non-X page for tasks that run beside X tasks: /notes/<board>?delay=<ms>
// (served under any host name, e.g. https://notes.test) saves notes; notes() lists them.

import https from "node:https";
import { selfSignedCert } from "../tls.mjs";

export const ACCOUNTS = [
  { handle: "@alpha", name: "Alpha" },
  { handle: "@beta", name: "Beta" },
  // A profile that says what the account is (its bio and site), for tasks that must write in its voice about real facts.
  {
    handle: "@gamma",
    name: "Gamma",
    bio: "Gamma is the spreadsheet add-on that fixes broken formulas: it watches your team's sheets, flags errors like #REF! and explains each fix in plain English. Works with Google Sheets and Excel.",
    site: "https://gamma.test",
  },
  { handle: "@locked", name: "Locked" },
];

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
#menu a,#menu button,#menu [role=button]{display:block;padding:6px}
[contenteditable]{border:1px solid #ccc;min-height:60px;padding:8px}
.acct-btn{position:absolute;bottom:16px;left:16px}
.post{border-bottom:1px solid #eee;padding:8px 0}
</style></head><body>${body}</body></html>`;
}

function nav(acct) {
  const items = ACCOUNTS.filter((a) => a.handle !== acct.handle)
    .map(
      (a) =>
        `<button data-testid="UserCell" aria-label="Switch to ${esc(a.handle)}" onclick="location.href='/i/switch?to=${encodeURIComponent(a.handle)}'">${esc(a.name)} ${esc(a.handle)}</button>`,
    )
    .join("");
  return `<nav>
  <a href="/home" data-testid="AppTabBar_Home_Link">Home</a><br>
  <a href="/compose/post" data-testid="SideNav_NewTweet_Button" role="link">Post</a>
  <div id="menu" role="group"><div>${esc(acct.name)} ${esc(acct.handle)}</div>
    <div role="button" tabindex="0" aria-expanded="false" id="personal"
      onclick="var p=document.getElementById('personal-list');var o=p.style.display!=='block';p.style.display=o?'block':'none';this.setAttribute('aria-expanded',String(o))">Personal accounts</div>
    <div id="personal-list" style="display:none">${items}</div>
    <a role="menuitem" href="/i/flow/login" data-testid="AccountSwitcher_AddAccount_Button">Add an existing account</a>
    <a role="menuitem" href="/logout" data-testid="AccountSwitcher_Logout_Button">Log out ${esc(acct.handle)}</a></div>
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

/** A notes board: a text box and a Post button (the same test ids as X's, so the scripted brain can use it). */
function notesPage(board) {
  return page(`Notes ${board}`, `<main>
  <h1>Notes: ${esc(board)}</h1>
  <div contenteditable="true" role="textbox" aria-label="Note text" id="editor"></div>
  <button data-testid="tweetButton" id="save" disabled>Post</button>
</main>
<script>
const editor = document.getElementById('editor');
const btn = document.getElementById('save');
editor.addEventListener('input', () => { btn.disabled = editor.innerText.trim().length === 0; });
btn.addEventListener('click', async () => {
  const res = await fetch('/api/note', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ board: ${JSON.stringify(board)}, text: editor.innerText.trim() }) });
  const { id } = await res.json();
  location.href = '/notes/${encodeURIComponent(board)}/' + id;
});
</script>`);
}

export function createFakeX() {
  let feed = {};
  let nextId = 1000;
  let notes = [];
  /** Follow clicks: { by, handle } (the agent must never follow an account). */
  const follows = [];
  /** Accounts a switch to silently does not reach (X stays on the account it was on), as real switches sometimes do. */
  const stuck = new Set();
  /** Images made on /grok/imagine (a tab the composer's "Generate with Grok" opens, like X's). */
  const images = [];

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
      if (stuck.has(to)) return send(302, "", "text/plain", { location: "/home" });
      const cookie = `acct=${encodeURIComponent(to)}; Path=/; SameSite=Lax; Secure`;
      const location = to === "@locked" ? "/account/access" : "/home";
      return send(302, "", "text/plain", { location, "set-cookie": cookie });
    }
    const board = /^\/notes\/([a-z0-9-]+)$/.exec(url.pathname);
    if (req.method === "GET" && board) {
      // ?delay=ms: a slow page, so tasks on it take long enough to overlap.
      const delay = Math.min(10_000, Number(url.searchParams.get("delay") || 0));
      setTimeout(() => send(200, notesPage(board[1])), delay);
      return;
    }
    const note = /^\/notes\/([a-z0-9-]+)\/(\d+)$/.exec(url.pathname);
    if (req.method === "GET" && note) {
      const n = notes.find((x) => String(x.id) === note[2]);
      return send(n ? 200 : 404, page(n ? `Note ${n.id}` : "Not found", `<main>${n ? `<p>${esc(n.text)}</p>` : "Not found"}</main>`));
    }
    if (req.method === "POST" && url.pathname === "/api/note") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { board: b, text } = JSON.parse(body || "{}");
        const id = nextId++;
        notes.push({ id, board: b, text, at: new Date().toISOString() });
        json(200, { id });
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/grok-compose") {
      // X's composer: "Add photos or video" opens a menu whose "Generate with Grok" opens Grok in a NEW TAB.
      return send(
        200,
        page(
          "Compose post / X",
          `<main><h1>Compose</h1><div role="textbox" contenteditable="true" aria-label="Post text"></div>
<button id="media" aria-haspopup="menu" aria-label="Add photos or video">Media</button>
<div id="media-menu" role="menu" hidden><div role="menuitem" tabindex="0" id="upload">Upload from computer</div><div role="menuitem" tabindex="0" id="grok">Generate with Grok</div></div>
<script>
const menu = document.getElementById("media-menu");
document.getElementById("media").addEventListener("click", () => (menu.hidden = !menu.hidden));
document.getElementById("grok").addEventListener("click", () => { menu.hidden = true; window.open("/grok/imagine", "_blank"); });
</script></main>`,
        ),
      );
    }
    if (req.method === "GET" && url.pathname === "/grok/imagine") {
      const prompt = url.searchParams.get("prompt");
      if (prompt) images.push({ prompt, at: new Date().toISOString() });
      return send(
        200,
        page(
          prompt ? "Image ready / Grok" : "Imagine / Grok",
          prompt
            ? `<main><h1>Image ready</h1><p>Your image of ${esc(prompt)} is ready.</p><button>Use in post</button></main>`
            : `<main><h1>Grok Imagine</h1><form><label>Describe the image <input name="prompt"></label><button>Generate</button></form></main>`,
        ),
      );
    }
    if (req.method === "GET" && url.pathname === "/mail") {
      // A tiny webmail inbox for "find something out" tasks; ?box=b is a second account's inbox.
      const box = url.searchParams.get("box") === "b" ? "b" : null;
      const mails = box ? [
        { id: 11, from: "Nora Quinn", subject: "Board meeting moved", body: "The board meeting moved to Tuesday at 3 pm." },
        { id: 12, from: "Omar Diaz", subject: "Contract signed", body: "The contract is signed; nothing more is needed from you." },
      ] : [
        { id: 1, from: "Paul Lee", subject: "T2 return ready for review", body: "Hi, the 2025 T2 return is ready. Please sign the engagement letter and send the Q3 bank statements by Friday." },
        { id: 2, from: "Suzie", subject: "Lunch?", body: "Are you free Thursday?" },
        { id: 3, from: "Paul Lee", subject: "Invoice 1042", body: "Invoice 1042 for $1,200 is due at the end of the month." },
      ];
      const open = url.searchParams.get("open");
      const mail = mails.find((m) => String(m.id) === open);
      const q = box ? `box=${box}&` : "";
      const list = mails.map((m) => `<li><a href="/mail?${q}open=${m.id}">${esc(m.from)}: ${esc(m.subject)}</a></li>`).join("");
      return send(200, page(box ? "Inbox (B) - Mail" : "Inbox - Mail", `<main><h1>Inbox</h1><ul>${list}</ul>${mail ? `<article><h2>${esc(mail.subject)}</h2><p>From: ${esc(mail.from)}</p><p>${esc(mail.body)}</p></article>` : ""}</main>`));
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
      const who = ACCOUNTS.find((a) => a.handle === handle);
      const bio = who.bio ? `<p data-testid="UserDescription">${esc(who.bio)}</p>${who.site ? `<a data-testid="UserUrl" href="${esc(who.site)}">${esc(who.site.replace(/^https?:\/\//, ""))}</a>` : ""}` : "";
      // Another account's profile has a Follow back button that names the handle (clicking it follows).
      const follow = handle === acct.handle ? "" : `<button data-testid="1-follow" aria-label="Follow back ${esc(handle)}" onclick="fetch('/api/follow',{method:'POST',body:${esc(JSON.stringify(handle))}}).then(()=>this.textContent='Following')">Follow back</button> <a href="/${profile[1]}">${esc(handle)}</a>`;
      return send(200, page(`${handle} / X`, `${nav(acct)}<main><h1>${esc(handle)}</h1>${follow}${who.bio ? `<p>${esc(who.name)}</p>` : ""}${bio}${posts || "<p>No posts yet</p>"}</main>`));
    }
    const status = /^\/([A-Za-z0-9_]+)\/status\/(\d+)$/.exec(url.pathname);
    if (req.method === "GET" && status) {
      const post = Object.values(feed).flat().find((p) => String(p.id) === status[2]);
      if (!post) return send(404, page("Not found / X", "<main>Not found</main>"));
      // X shows a post under its author's handle, whatever handle the URL named.
      if (`@${status[1]}` !== post.account) return send(302, "", "text/plain", { location: `/${post.account.slice(1)}/status/${post.id}` });
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
    if (req.method === "POST" && url.pathname === "/api/follow") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        follows.push({ by: acct.handle, handle: body });
        json(200, { ok: true });
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

  const server = https.createServer(selfSignedCert(["x.com", "twitter.com"]), handler);
  return {
    server,
    listen: (port = 443, host = "127.0.0.1") => new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(() => resolve())),
    feed: () => feed,
    /** Earlier posts of an account, as if it had posted them (its profile lists them). */
    seed: (handle, texts) => {
      for (const text of texts) (feed[handle] ??= []).push({ id: nextId++, account: handle, text, media: [], at: new Date().toISOString() });
    },
    notes: () => notes,
    follows: () => follows,
    /** Switches to these handles fail from now on (X stays on its account). */
    failSwitches: (handles) => handles.forEach((h) => stuck.add(h)),
    images: () => images,
  };
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("server.mjs")) {
  const portArg = process.argv.indexOf("--port");
  const port = portArg > -1 ? Number(process.argv[portArg + 1]) : 443;
  const fx = createFakeX();
  fx.listen(port).then((p) => process.stderr.write(`fake X listening on https://127.0.0.1:${p}\n`));
}
