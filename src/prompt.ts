import { createInterface, type Interface } from "node:readline";
import { Writable } from "node:stream";

/**
 * Ask for a secret without echoing it. On a TTY the typed characters are swallowed; when stdin is a
 * pipe the next line is consumed instead, so a script can feed values one per line.
 */
export async function askHidden(question: string, input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout): Promise<string> {
  let muted = false;
  const sink = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) output.write(chunk);
      cb();
    },
  });
  const rl: Interface = createInterface({ input, output: sink, terminal: !!input.isTTY });
  return new Promise<string>((resolve) => {
    rl.question(question, (answer) => {
      muted = false;
      output.write("\n");
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

/** Read everything from a non-TTY stdin, stripping one trailing newline. */
export async function readStdin(input: NodeJS.ReadStream = process.stdin): Promise<string | undefined> {
  if (input.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const c of input) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString("utf8");
  return s.length ? s.replace(/\r?\n$/, "") : undefined;
}
