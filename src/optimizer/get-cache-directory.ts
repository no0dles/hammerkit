import { join } from 'path'

export function getCacheDirectory(nodeId: string): string {
  return join(getHammerkitDirectory(), nodeId, 'cache')
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
