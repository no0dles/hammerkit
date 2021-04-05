import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'

export function copy(src: string, dest: string) {
  const exists = existsSync(src)
  if (!exists) {
    return
  }

  const stats = lstatSync(src)
  if (stats.isDirectory()) {
    mkdirSync(dest, { recursive: true })
    for (const child of readdirSync(src)) {
      copy(join(src, child), join(dest, child))
    }
  } else {
    copyFileSync(src, dest)
  }
}
