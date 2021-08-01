import { createHash } from 'crypto'
import { Environment } from '../executer/environment'

export async function calculateChecksum(environment: Environment, path: string): Promise<string> {
  const input = await environment.file.read(path)
  return createHash('sha1').update(input).digest('hex')
}
