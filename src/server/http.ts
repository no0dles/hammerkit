import { IncomingMessage, ServerResponse } from 'http'

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

// An answer to the caller, thrown from wherever the request turns out to be wrong.
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export const MAX_BODY_BYTES = 64 * 1024

export async function readJson(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  if (!/^application\/json(;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'send application/json')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      throw new HttpError(413, `the request is larger than ${limit} bytes`)
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'the body is not valid JSON')
  }
}
