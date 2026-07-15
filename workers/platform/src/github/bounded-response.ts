export type BoundedResponseFailure =
  | "empty-body"
  | "invalid-length"
  | "limit-exceeded"
  | "stream-unavailable";

export async function readBoundedResponseBytes(
  response: Response,
  maxBytes: number,
  failure: (reason: BoundedResponseFailure) => Error,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(declaredLength)) throw failure("invalid-length");
    const parsedLength = Number.parseInt(declaredLength, 10);
    if (!Number.isSafeInteger(parsedLength)) throw failure("invalid-length");
    if (parsedLength > maxBytes) throw failure("limit-exceeded");
  }
  if (response.body === null) throw failure("empty-body");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await reader.read();
    } catch {
      throw failure("stream-unavailable");
    }
    if (result.done) break;
    totalBytes += result.value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw failure("limit-exceeded");
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
