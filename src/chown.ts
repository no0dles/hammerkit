import { chownSync, readdirSync } from 'fs'
import { join } from 'path'

export async function chown(directory: string) {
  chownSync(directory, process.getuid(), process.getgid())
  const subDirs = readdirSync(directory, { withFileTypes: true })
  for (const subDir of subDirs) {
    chownSync(join(directory, subDir.name), process.getuid(), process.getgid())
    if (subDir.isDirectory()) {
      await chown(join(directory, subDir.name))
    }
  }
}
