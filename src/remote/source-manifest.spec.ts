import { deniedSourcePath, hashSource, sourceManifestSchema } from './source-manifest'

const digest = (char: string) => char.repeat(64)
const file = (path: string, char = 'a', mode: 'file' | 'exec' = 'file') => ({
  path,
  sha256: digest(char),
  size: 3,
  mode,
})

describe('hashSource', () => {
  it('names the same files the same, whatever order they come in', () => {
    const a = { files: [file('a.txt', 'a'), file('b/c.txt', 'b')] }
    const b = { files: [file('b/c.txt', 'b'), file('a.txt', 'a')] }
    expect(hashSource(a)).toBe(hashSource(b))
    expect(hashSource(a)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('changes with a path, a content digest or the executable bit, not with the size', () => {
    const base = hashSource({ files: [file('a.txt')] })
    expect(hashSource({ files: [file('b.txt')] })).not.toBe(base)
    expect(hashSource({ files: [file('a.txt', 'b')] })).not.toBe(base)
    expect(hashSource({ files: [file('a.txt', 'a', 'exec')] })).not.toBe(base)
    expect(hashSource({ files: [{ ...file('a.txt'), size: 99 }] })).toBe(base)
  })
})

describe('sourceManifestSchema', () => {
  const parse = (value: unknown) => sourceManifestSchema.safeParse(value)

  it('takes a list of files and defaults the mode', () => {
    const parsed = parse({ files: [{ path: 'src/a.ts', sha256: digest('a'), size: 3 }] })
    expect(parsed.success && parsed.data.files[0].mode).toBe('file')
  })

  it('refuses paths that leave the project, repeat or are not paths', () => {
    for (const path of ['../a', '/etc/passwd', 'a/../b', 'a//b', 'a\\b', '']) {
      expect(parse({ files: [{ path, sha256: digest('a'), size: 1 }] }).success).toBe(false)
    }
    expect(parse({ files: [file('a.txt'), file('a.txt', 'b')] }).success).toBe(false)
  })

  it('refuses a digest that is not lowercase hex, an empty list and unknown fields', () => {
    expect(parse({ files: [{ path: 'a', sha256: 'ABC', size: 1 }] }).success).toBe(false)
    expect(parse({ files: [] }).success).toBe(false)
    expect(parse({ files: [file('a')], extra: 1 }).success).toBe(false)
  })

  it('refuses files and trees above the limits', () => {
    expect(parse({ files: [{ ...file('a'), size: 33 * 1024 * 1024 }] }).success).toBe(false)
    const big = Array.from({ length: 33 }, (_, i) => ({ ...file(`f${i}`), size: 32 * 1024 * 1024 }))
    expect(parse({ files: big }).success).toBe(false)
  })
})

describe('deniedSourcePath', () => {
  it('denies credentials and history', () => {
    for (const path of [
      '.env',
      '.env.local',
      'apps/web/.env.production',
      '.npmrc',
      'home/.netrc',
      'keys/server.pem',
      'ssh/id_ed25519',
      '.git/config',
      'sub/.ssh/known_hosts',
      '.aws/credentials',
      '.kube/config',
    ]) {
      expect(deniedSourcePath(path)).not.toBeNull()
    }
  })

  it('lets ordinary files and the documented examples through', () => {
    for (const path of [
      'src/index.ts',
      '.env.example',
      '.env.sample',
      'config/.env.template',
      'id_rsa.pub',
      'a/.gitignore',
    ]) {
      expect(deniedSourcePath(path)).toBeNull()
    }
  })
})
