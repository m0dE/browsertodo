// Bundles the helper entry points into dist/. Everything (MCP SDK, Jev SDK,
// shared contracts, core) is bundled so dist/ runs with plain `node`, except
// node-pty: it is a native module, loaded at runtime from
// apps/helper/node_modules (dist/ sits next to it, so Node finds it).
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: {
    host: join(root, "src/host.ts"),
    "mcp-server": join(root, "src/mcp-server.ts"),
    install: join(root, "src/install.ts"),
  },
  outdir: join(root, "dist"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  logLevel: "warning",
  external: ["node-pty"],
  banner: {
    js: 'import { createRequire as __btCreateRequire } from "node:module"; const require = __btCreateRequire(import.meta.url);',
  },
});
