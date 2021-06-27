import { createHash } from 'crypto'
import { createReadStream } from 'fs'

export function calculateChecksum(path: string): Promise<string> {
  return new Promise(function (resolve, reject) {
    const hash = createHash('sha1')
    const input = createReadStream(path)

    input.on('error', reject)

    input.on('data', (chunk) => {
      hash.update(chunk)
    })

    input.on('close', () => {
      resolve(hash.digest('hex'))
    })
  })
}
