import { join } from 'path'
import { createHash } from 'crypto'

export function getCacheDirectory(nodeId: string): string {
  return join(getHammerkitDirectory(), 'cache', nodeId)
}

export function getCacheDescriptionFile(nodeId: string): string {
  return join(getCacheDirectory(nodeId), 'description.json')
}

export function getCacheStatsDirectory(nodeId: string, cwd: string): string {
  return join(getCacheDirectory(nodeId), createHash('sha1').update(cwd).digest('hex'))
}

export function getCacheStatsFile(nodeId: string, cwd: string): string {
  return join(getCacheStatsDirectory(nodeId, cwd), 'stats.json')
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
