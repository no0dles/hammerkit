import { createSource, parseWorkSource } from './parse-work-source'
import { WorkEnvironmentVariables } from '../../environment/replace-env-variables'

const noEnvs: WorkEnvironmentVariables = { variables: {}, replacements: [] }

describe('parse-work-source', () => {
  it('returns an empty list for null/undefined sources', () => {
    expect(parseWorkSource('/proj', null, noEnvs)).toEqual([])
    expect(parseWorkSource('/proj', undefined, noEnvs)).toEqual([])
  })

  describe('without a wildcard', () => {
    it('treats a path with an extension as a file', () => {
      const [src] = parseWorkSource('/proj', ['dist/app.js'], noEnvs)
      expect(src.absolutePath).toBe('/proj/dist/app.js')
      expect(src.isFile).toBe(true)
      expect(src.matcher('/proj/dist/app.js', '/proj')).toBe(true)
      expect(src.matcher('/proj/dist/other.js', '/proj')).toBe(false)
    })

    it('treats a path without an extension as a directory', () => {
      const [src] = parseWorkSource('/proj', ['src'], noEnvs)
      expect(src.absolutePath).toBe('/proj/src')
      expect(src.isFile).toBe(false)
      expect(src.matcher('/proj/src/index.ts', '/proj')).toBe(true)
    })
  })

  describe('with a leading wildcard', () => {
    it('anchors the absolute path to cwd and matches relative paths', () => {
      const [src] = parseWorkSource('/proj', ['*.spec.ts'], noEnvs)
      expect(src.absolutePath).toBe('/proj')
      expect(src.isFile).toBe(false)
      expect(src.matcher('/proj/a.spec.ts', '/proj')).toBe(true)
      expect(src.matcher('/proj/a.ts', '/proj')).toBe(false)
    })
  })

  describe('with a mid-string wildcard', () => {
    it('uses the prefix for the absolute path and globs against the full path', () => {
      const [src] = parseWorkSource('/proj', ['src/*.ts'], noEnvs)
      expect(src.absolutePath).toBe('/proj/src/')
      expect(src.isFile).toBe(false)
      expect(src.matcher('/proj/src/a.ts', '/proj')).toBe(true)
      expect(src.matcher('/proj/src/sub/a.ts', '/proj')).toBe(false)
    })
  })

  describe('createSource', () => {
    it('builds a prefix matcher from an absolute path', () => {
      const src = createSource('/proj/dist')
      expect(src.absolutePath).toBe('/proj/dist')
      expect(src.source).toBe('/proj/dist')
      expect(src.matcher('/proj/dist/app.js', '/proj')).toBe(true)
      expect(src.matcher('/proj/other', '/proj')).toBe(false)
    })
  })
})
