import { join } from 'path'
import {
  getCacheDescriptionFile,
  getCacheDirectory,
  getCacheStatsFile,
  getHammerkitDirectory,
} from './get-cache-directory'

function withPlatform<T>(value: NodeJS.Platform, env: Record<string, string | undefined>, fn: () => T): T {
  const originalPlatform = process.platform
  const originalEnv: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) originalEnv[k] = process.env[k]
  Object.defineProperty(process, 'platform', { value, configurable: true })
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

describe('cache directory helpers', () => {
  it('builds the per-cache directory under the hammerkit directory', () => {
    const dir = getCacheDirectory('abc123')
    expect(dir.endsWith(join('cache', 'abc123'))).toBe(true)
  })

  it('builds the description file path under the cache directory', () => {
    expect(getCacheDescriptionFile('id').endsWith(join('cache', 'id', 'description.json'))).toBe(true)
  })

  it('builds the stats file path under the cache directory', () => {
    expect(getCacheStatsFile('id').endsWith(join('cache', 'id', 'stats.json'))).toBe(true)
  })

  describe('getHammerkitDirectory', () => {
    it('uses %APPDATA% on Windows', () => {
      withPlatform('win32', { APPDATA: 'C:\\Users\\X\\AppData\\Roaming' }, () => {
        expect(getHammerkitDirectory()).toBe(join('C:\\Users\\X\\AppData\\Roaming', 'hammerkit'))
      })
    })

    it('uses ~/Library/Application Support on macOS', () => {
      withPlatform('darwin', { HOME: '/Users/x' }, () => {
        expect(getHammerkitDirectory()).toBe(join('/Users/x', 'Library', 'Application Support', 'hammerkit'))
      })
    })

    it('uses ~/.hammerkit on Linux', () => {
      withPlatform('linux', { HOME: '/home/x' }, () => {
        expect(getHammerkitDirectory()).toBe(join('/home/x', '.hammerkit'))
      })
    })
  })
})
