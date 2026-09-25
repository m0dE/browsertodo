// Stands in for claude.exe in stream-json mode: echoes its args, then answers
// every stdin user message with an assistant text and a result event, and
// exits when stdin closes. FAKE_CLAUDE_HANG=1: never exits until killed.
// FAKE_CLAUDE_SLOW_MS: delay before answering each message.
// FAKE_CLAUDE_PARTIAL=1: stream the answer first as --include-partial-messages
// stream_event lines (one text_delta per word, 5 ms apart), like Claude Code 2.1.
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
// Like real Claude Code, the init event names the model it runs (and comes again with every later turn).
const modelAt = args.indexOf("--model");
const init = () => out({ type: "system", subtype: "init", model: modelAt >= 0 ? args[modelAt + 1] : "fake", args, cwd: process.cwd(), nested: process.env.CLAUDECODE ?? null, child: process.env.CLAUDE_CODE_CHILD_SESSION ?? null });
init();
let turns = 0;
process.stdout.write("not json\n");
const slow = Number(process.env.FAKE_CLAUDE_SLOW_MS || 0);
const rl = createInterface({ input: process.stdin });
let chain = Promise.resolve();
rl.on("line", (line) => {
  chain = chain.then(async () => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (slow) await new Promise((r) => setTimeout(r, slow));
    if (turns++ > 0) init();
    const text = `got: ${msg.message.content}`;
    const id = `msg_fake_${turns}`;
    if (process.env.FAKE_CLAUDE_PARTIAL === "1") {
      const se = (event) => out({ type: "stream_event", event, session_id: "s", parent_tool_use_id: null, uuid: "u" });
      se({ type: "message_start", message: { id, type: "message", role: "assistant", content: [] } });
      se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      for (const part of text.split(/(?<= )/)) {
        se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: part } });
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    out({ type: "assistant", message: { id, role: "assistant", content: [{ type: "text", text }] } });
    out({ type: "result", subtype: "success", is_error: false, result: "✓ done" });
  });
});
rl.on("close", () => {
  if (process.env.FAKE_CLAUDE_HANG === "1") setInterval(() => {}, 1000);
  else void chain.then(() => process.exit(0));
});
