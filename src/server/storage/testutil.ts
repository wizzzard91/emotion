import { Readable } from 'node:stream';

export async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** A stream that yields a few chunks and then fails, like an interrupted upload. */
export function failingStream(chunks: Buffer[], error: Error): Readable {
  let i = 0;
  return new Readable({
    read() {
      const chunk = chunks[i++];
      if (chunk) setImmediate(() => this.push(chunk));
      else setImmediate(() => this.destroy(error));
    },
  });
}
