import { join } from 'path'

export function getCacheDirectory(cacheId: string): string {
  return join(getHammerkitDirectory(), 'cache', cacheId)
}

export function getCacheDescriptionFile(cacheId: string): string {
  return join(getCacheDirectory(cacheId), 'description.json')
}

export function getCacheStatsFile(cacheId: string): string {
  return join(getCacheDirectory(cacheId), 'stats.json')
}

// `HAMMERKIT_DIR` puts hammerkit's directory (the cache) elsewhere than below the home directory;
// a server uses it to keep the caches of runs apart.
export function getHammerkitDirectory(): string {
  if (process.env.HAMMERKIT_DIR) {
    return process.env.HAMMERKIT_DIR
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA as string, 'hammerkit')
  } else if (process.platform === 'darwin') {
    return join(process.env.HOME as string, 'Library', 'Application Support', 'hammerkit')
  } else {
    return join(process.env.HOME as string, '.hammerkit')
  }
}
