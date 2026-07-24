// SSE parser: converts a ReadableStream<Uint8Array> into a stream of {event,data}.
// Correctly accumulates frames even when split across chunk boundaries (buffer + '\n\n' separator).

function parseFrame(frame: string): { event: string; data: any } | null {
  let event = 'message';
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return null;
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return { event, data };
  }
}

export async function* parseSSEStream(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: any }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const parsed = parseFrame(frame);
        if (parsed) yield parsed;
      }
    }
    const last = parseFrame(buf);
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}
