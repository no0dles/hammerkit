import { createHash } from 'crypto'
import { Environment } from '../executer/environment'

// Hashes the raw bytes: decoding to text first would map every invalid UTF-8
// sequence to U+FFFD, so two different binary files could share a checksum.
// For UTF-8 text the result is unchanged. sha256, which nobody can make two files share:
// a cache hit is also what a verified check counts (check-key.ts).
export async function calculateChecksum(environment: Environment, path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of environment.file.readStream(path)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}
