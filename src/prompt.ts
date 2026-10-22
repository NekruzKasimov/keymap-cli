import { createInterface, type Interface } from "node:readline";
import { Writable } from "node:stream";

/**
 * One readline over stdin for the whole command. On a TTY the typed characters are swallowed; on a pipe each
 * question consumes the next line, so a script can feed values one per line. A closed stream is an error
 * (never a silent empty answer).
 */
export class Prompter {
  private rl?: Interface;
  private muted = false;
  private closed = false;
  private lines: string[] = [];
  private waiters: Array<{ resolve: (s: string) => void; reject: (e: Error) => void }> = [];

  constructor(private input: NodeJS.ReadStream = process.stdin, private output: NodeJS.WriteStream = process.stdout) {}

  private iface(): Interface {
    if (this.rl) return this.rl;
    const sink = new Writable({
      write: (chunk, _enc, cb) => {
        if (!this.muted) this.output.write(chunk);
        cb();
      },
    });
    this.rl = createInterface({ input: this.input, output: sink, terminal: !!this.input.isTTY });
    // Lines are queued, so piped input that arrives before the next question is not lost.
    this.rl.on("line", (l) => {
      const w = this.waiters.shift();
      if (w) w.resolve(l);
      else this.lines.push(l);
    });
    this.rl.on("close", () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w.reject(new Error("input ended before a value was given"));
    });
    return this.rl;
  }

  /** Ask for a secret without echoing it. */
  async askHidden(question: string): Promise<string> {
    this.iface();
    this.output.write(question);
    this.muted = true;
    try {
      if (this.lines.length) return this.lines.shift() as string;
      if (this.closed) throw new Error("input ended before a value was given");
      return await new Promise<string>((resolve, reject) => this.waiters.push({ resolve, reject }));
    } finally {
      this.muted = false;
      this.output.write("\n");
    }
  }

  close(): void {
    this.rl?.close();
  }
}

/** Read everything from a non-TTY stdin. Returns undefined on a TTY, "" when the pipe was empty. */
export async function readStdin(input: NodeJS.ReadStream = process.stdin): Promise<string | undefined> {
  if (input.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const c of input) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}
