/** Newline-delimited JSON, used on the named pipe between the MCP server and the helper. */
import { StringDecoder } from "node:string_decoder";

export function encodeLine(msg: unknown): string {
  // JSON.stringify escapes newlines inside strings, so one message is one line.
  return JSON.stringify(msg) + "\n";
}

export class LineDecoder {
  private readonly text = new StringDecoder("utf8");
  private rest = "";

  push(chunk: Buffer | string): unknown[] {
    this.rest += typeof chunk === "string" ? chunk : this.text.write(chunk);
    const out: unknown[] = [];
    let nl: number;
    while ((nl = this.rest.indexOf("\n")) >= 0) {
      const line = this.rest.slice(0, nl).trim();
      this.rest = this.rest.slice(nl + 1);
      if (line) out.push(JSON.parse(line));
    }
    return out;
  }
}
