// Stands in for claude.exe: echoes its args as stream-json, then either exits
// or hangs (FAKE_CLAUDE_HANG=1) until killed.
const args = process.argv.slice(2);
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", args, cwd: process.cwd(), nested: process.env.CLAUDECODE ?? null }) + "\n");
process.stdout.write("not json\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", text: "✓ done" }) + "\n");
if (process.env.FAKE_CLAUDE_HANG === "1") setInterval(() => {}, 1000);
