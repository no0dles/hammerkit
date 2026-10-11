import { bundleSchema, hashBundle, isBundlePath } from './bundle'

const bundle = {
  entry: '.hammerkit.yaml',
  files: { '.hammerkit.yaml': 'tasks: {}\n', 'sub/other.yaml': 'tasks: {}\n' },
}

describe('bundle', () => {
  it('has the same hash wherever the files are listed from', () => {
    const reordered = {
      entry: bundle.entry,
      files: { 'sub/other.yaml': 'tasks: {}\n', '.hammerkit.yaml': 'tasks: {}\n' },
    }
    expect(hashBundle(bundle)).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(hashBundle(reordered)).toBe(hashBundle(bundle))
  })

  it('has another hash when a file, its name or the entry changes', () => {
    const hash = hashBundle(bundle)
    expect(hashBundle({ ...bundle, files: { ...bundle.files, 'sub/other.yaml': 'tasks: { a: {} }\n' } })).not.toBe(hash)
    expect(hashBundle({ ...bundle, files: { ...bundle.files, 'sub/renamed.yaml': 'tasks: {}\n' } })).not.toBe(hash)
    expect(hashBundle({ entry: 'sub/other.yaml', files: bundle.files })).not.toBe(hash)
  })

  it('does not confuse the end of one file with the start of the next', () => {
    const a = { entry: 'a', files: { a: 'x', b: 'yz' } }
    const b = { entry: 'a', files: { a: 'xy', b: 'z' } }
    expect(hashBundle(a)).not.toBe(hashBundle(b))
  })

  it('accepts paths inside the bundle only', () => {
    for (const ok of ['a.yaml', 'a/b/c.yaml', '.hammerkit.yaml']) {
      expect(isBundlePath(ok)).toBe(true)
    }
    for (const bad of [
      '',
      '/etc/passwd',
      '../x',
      'a/../../x',
      'a//b',
      './a',
      'a/./b',
      'a\\b',
      'a\0b',
      'x'.repeat(201),
    ]) {
      expect(isBundlePath(bad)).toBe(false)
    }
  })

  it('defaults the entry and needs it among the files', () => {
    expect(bundleSchema.parse({ files: { '.hammerkit.yaml': '' } }).entry).toBe('.hammerkit.yaml')
    expect(bundleSchema.safeParse({ files: { 'other.yaml': '' } }).success).toBe(false)
    expect(bundleSchema.safeParse({ entry: 'constructor', files: {} }).success).toBe(false)
    expect(bundleSchema.safeParse({ files: { '.hammerkit.yaml': '' }, extra: 1 }).success).toBe(false)
  })

  it('limits the number and the size of the files', () => {
    const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`f${i}.yaml`, '']))
    expect(bundleSchema.safeParse({ entry: 'f0.yaml', files: many }).success).toBe(false)
    expect(bundleSchema.safeParse({ files: { '.hammerkit.yaml': 'x'.repeat(1024 * 1024 + 1) } }).success).toBe(false)
  })
})
