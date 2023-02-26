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

export function getHammerkitDirectory(): string {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA as string, 'hammerkit')
  } else if (process.platform === 'darwin') {
    return join(process.env.HOME as string, 'Library', 'Application Support', 'hammerkit')
  } else {
    return join(process.env.HOME as string, '.hammerkit')
  }
}
