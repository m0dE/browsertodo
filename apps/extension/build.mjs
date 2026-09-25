// Bundles the extension into dist/: background.js, options.js, static files and icons.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = dirname(fileURLToPath(import.meta.url));
// Output to the repo root so Chrome's "Load unpacked" points at <repo>/dist.
const dist = join(root, "..", "..", "dist");
const iconDir = join(root, "static", "icons");

rmSync(dist, { recursive: true, force: true });
mkdirSync(iconDir, { recursive: true });
for (const size of [16, 48, 128]) {
  const file = join(iconDir, `icon${size}.png`);
  if (!existsSync(file)) writeFileSync(file, iconPng(size));
}

// Build-time config: env BROWSERTODO_GOOGLE_CLIENT_ID, else config.json { "googleClientId": "..." }
// (gitignored; see config.example.json). Empty = the Log In button explains that sign-in is not set up.
function readConfig() {
  const file = join(root, "config.json");
  let fromFile = {};
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`apps/extension/config.json is not valid JSON: ${err.message}`);
    }
  }
  return { googleClientId: String(process.env.BROWSERTODO_GOOGLE_CLIENT_ID ?? fromFile.googleClientId ?? "").trim() };
}
const config = readConfig();
if (!config.googleClientId) console.log("[build] no Google client ID: sign-in is disabled in this build (see apps/extension/README.md)");

const common = {
  bundle: true,
  platform: "browser",
  target: "chrome120",
  format: "esm",
  sourcemap: false,
  minify: false,
  // keepNames would wrap functions in __name(), which breaks the page snapshot
  // function that is serialized with Function.prototype.toString.
  keepNames: false,
  logLevel: "info",
  define: { __BROWSERTODO_GOOGLE_CLIENT_ID__: JSON.stringify(config.googleClientId) },
};
await build({ ...common, entryPoints: [join(root, "src/background.ts")], outfile: join(dist, "background.js") });
await build({ ...common, entryPoints: [join(root, "src/options/options.ts")], outfile: join(dist, "options.js") });
await build({ ...common, entryPoints: [join(root, "src/sidepanel/sidepanel.ts")], outfile: join(dist, "sidepanel.js") });
cpSync(join(root, "static"), dist, { recursive: true });

/** Solid rounded-ish square icon: indigo with a white check-box stripe. */
function iconPng(size) {
  const rows = [];
  const r = Math.max(2, Math.round(size * 0.18));
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4); // filter byte 0 + RGBA
    for (let x = 0; x < size; x++) {
      const cx = Math.min(x, size - 1 - x);
      const cy = Math.min(y, size - 1 - y);
      const corner = cx < r && cy < r && (r - cx) ** 2 + (r - cy) ** 2 > r * r;
      const inMark = y > size * 0.45 && y < size * 0.58 && x > size * 0.22 && x < size * 0.78;
      const px = corner ? [0, 0, 0, 0] : inMark ? [255, 255, 255, 255] : [67, 56, 202, 255];
      px.forEach((v, i) => (row[1 + x * 4 + i] = v));
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}
