import { request } from 'http'

export interface HttpGetResult {
  status: number
  body: string
}

export function httpGet(host: string, port: number, path: string, timeoutMs = 10000): Promise<HttpGetResult> {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, path, method: 'GET', timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`))
    })
    req.end()
  })
}
