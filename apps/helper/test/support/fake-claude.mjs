// Stands in for claude.exe in stream-json mode: echoes its args, then answers
// every stdin user message with an assistant text and a result event, and
// exits when stdin closes. FAKE_CLAUDE_HANG=1: never exits until killed.
// FAKE_CLAUDE_SLOW_MS: delay before answering each message.
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
// Like real Claude Code, the init event names the model it runs.
const modelAt = args.indexOf("--model");
out({ type: "system", subtype: "init", model: modelAt >= 0 ? args[modelAt + 1] : "fake", args, cwd: process.cwd(), nested: process.env.CLAUDECODE ?? null, child: process.env.CLAUDE_CODE_CHILD_SESSION ?? null });
process.stdout.write("not json\n");
const slow = Number(process.env.FAKE_CLAUDE_SLOW_MS || 0);
const rl = createInterface({ input: process.stdin });
let chain = Promise.resolve();
rl.on("line", (line) => {
  chain = chain.then(async () => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (slow) await new Promise((r) => setTimeout(r, slow));
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `got: ${msg.message.content}` }] } });
    out({ type: "result", subtype: "success", is_error: false, result: "✓ done" });
  });
});
rl.on("close", () => {
  if (process.env.FAKE_CLAUDE_HANG === "1") setInterval(() => {}, 1000);
  else void chain.then(() => process.exit(0));
});
