import { createHash } from 'crypto'
import { Environment } from '../executer/environment'

// Hashes the raw bytes: decoding to text first would map every invalid UTF-8
// sequence to U+FFFD, so two different binary files could share a checksum.
// For UTF-8 text the result is unchanged.
export async function calculateChecksum(environment: Environment, path: string): Promise<string> {
  const hash = createHash('sha1')
  for await (const chunk of environment.file.readStream(path)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}
