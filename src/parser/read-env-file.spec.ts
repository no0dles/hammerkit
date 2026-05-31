import { join } from 'path'
import { readEnvFile } from './read-env-file'
import { Environment } from '../executer/environment'

// Build an Environment whose file context serves .env files from an in-memory map
// keyed by directory. readEnvFile asks for `join(<dir>, '.env')`, so build the
// keys the same way (native separators) — keeps the test correct on Windows too.
function envWithFiles(dirs: { [dir: string]: string }): Environment {
  const files: { [path: string]: string } = {}
  for (const [dir, content] of Object.entries(dirs)) {
    files[join(dir, '.env')] = content
  }
  return {
    file: {
      exists: vi.fn(async (p: string) => p in files),
      read: vi.fn(async (p: string) => files[p]),
    },
  } as unknown as Environment
}

describe('read-env-file', () => {
  it('parses KEY=VALUE pairs from a .env file', async () => {
    const env = envWithFiles({ proj: 'A=1\nB=2' })
    expect(await readEnvFile('proj', env)).toEqual({ A: '1', B: '2' })
  })

  it('keeps "=" characters in the value and skips lines without "="', async () => {
    const env = envWithFiles({ proj: 'URL=http://x?y=z\nNOEQ\n\nC=3' })
    expect(await readEnvFile('proj', env)).toEqual({ URL: 'http://x?y=z', C: '3' })
  })

  it('does not overwrite values already present in baseEnv', async () => {
    const env = envWithFiles({ proj: 'A=fromfile\nB=2' })
    expect(await readEnvFile('proj', env, { A: 'base' })).toEqual({ A: 'base', B: '2' })
  })

  it('returns the base env when no .env file exists', async () => {
    const env = envWithFiles({})
    expect(await readEnvFile('proj', env, { X: 'y' })).toEqual({ X: 'y' })
  })

  it('reads the basename .env first, then the full path', async () => {
    const env = envWithFiles({ b: 'FROM_B=1', 'a/b': 'FROM_AB=2' })
    expect(await readEnvFile('a/b', env)).toEqual({ FROM_B: '1', FROM_AB: '2' })
  })
})
