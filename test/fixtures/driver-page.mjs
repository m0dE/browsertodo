// The page the driver e2e scripts act on: a link, a counter button, a text input in a form, a
// contenteditable editor, a hidden file input and a tall body to scroll, each reporting what
// happened to it in the page's text (Count, trusted, Submitted, Files, Last key, ScrollY).

/** The page's HTML. `head`: more markup for <head> (e.g. the iframe-injector's meta tags). */
export const driverPage = ({ title, heading, head = "" }) => `<!doctype html><html><head><title>${title}</title>${head}
<style>body{font-family:sans-serif} .tall{height:3000px} #gone{display:none}</style></head><body>
<h1>${heading}</h1>
<a href="/other" data-testid="other-link">Other page</a>
<button id="inc" data-testid="incButton" onclick="document.getElementById('count').textContent = String(++window.clicks); document.getElementById('trusted').textContent = String(event.isTrusted)">Increment</button>
<p>Count: <span id="count">0</span> trusted: <span id="trusted">-</span></p>
<form onsubmit="event.preventDefault(); document.getElementById('submitted').textContent = document.getElementById('name').value">
<label for="name">Your name</label><input id="name" type="text"></form>
<p>Submitted: <span id="submitted">none</span></p>
<div id="editor" role="textbox" contenteditable="true" aria-label="Compose text" style="border:1px solid #999;min-height:40px"></div>
<input type="file" id="file" style="display:none" onchange="document.getElementById('files').textContent = [...this.files].map(f => f.name + ':' + f.size).join(',')">
<p>Files: <span id="files">none</span></p>
<p>Last key: <span id="lastkey">none</span></p>
<p>ScrollY: <span id="scrolly">0</span></p>
<button id="gone">Invisible button</button>
<input type="hidden" name="secret" value="x">
<div class="tall"></div>
<script>
window.clicks = 0;
document.addEventListener('keydown', e => { document.getElementById('lastkey').textContent = (e.ctrlKey ? 'Control+' : '') + e.key; });
addEventListener('scroll', () => { document.getElementById('scrolly').textContent = String(Math.round(scrollY)); });
</script></body></html>`;

/** Where the page's link goes. */
export const OTHER_PAGE = "<title>Other</title><p>other page</p>";

/** The index of the first element of a read_page snapshot that matches `pred`. */
export function findIndex(snap, pred) {
  const el = snap.elements.find(pred);
  if (!el) throw new Error(`element not found in ${JSON.stringify(snap.elements)}`);
  return el.index;
}
