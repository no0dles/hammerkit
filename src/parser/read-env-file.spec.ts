import { readEnvFile } from './read-env-file'
import { Environment } from '../executer/environment'

// Build an Environment whose file context serves .env files from an in-memory map,
// keyed by the path readEnvFile asks for (always `<dir>/.env`).
function envWithFiles(files: { [path: string]: string }): Environment {
  return {
    file: {
      exists: jest.fn(async (p: string) => p in files),
      read: jest.fn(async (p: string) => files[p]),
    },
  } as unknown as Environment
}

describe('read-env-file', () => {
  it('parses KEY=VALUE pairs from a .env file', async () => {
    const env = envWithFiles({ 'proj/.env': 'A=1\nB=2' })
    expect(await readEnvFile('proj', env)).toEqual({ A: '1', B: '2' })
  })

  it('keeps "=" characters in the value and skips lines without "="', async () => {
    const env = envWithFiles({ 'proj/.env': 'URL=http://x?y=z\nNOEQ\n\nC=3' })
    expect(await readEnvFile('proj', env)).toEqual({ URL: 'http://x?y=z', C: '3' })
  })

  it('does not overwrite values already present in baseEnv', async () => {
    const env = envWithFiles({ 'proj/.env': 'A=fromfile\nB=2' })
    expect(await readEnvFile('proj', env, { A: 'base' })).toEqual({ A: 'base', B: '2' })
  })

  it('returns the base env when no .env file exists', async () => {
    const env = envWithFiles({})
    expect(await readEnvFile('proj', env, { X: 'y' })).toEqual({ X: 'y' })
  })

  it('reads the basename .env first, then the full path', async () => {
    const env = envWithFiles({ 'b/.env': 'FROM_B=1', 'a/b/.env': 'FROM_AB=2' })
    expect(await readEnvFile('a/b', env)).toEqual({ FROM_B: '1', FROM_AB: '2' })
  })
})
