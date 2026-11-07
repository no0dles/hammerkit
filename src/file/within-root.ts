import { lstat } from 'fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'path'

/**
 * Why a path would carry a read or write out of a root that somebody else wrote (a
 * checkout, a sandbox), or null when it stays inside. A path may not lead out of the
 * root, and none of its parts that exist may be a symbolic link, since docker, tar
 * and the file system would follow it wherever it points. A part that doesn't exist
 * yet is fine, it can't be a link until something makes it.
 */
export async function findRootEscape(root: string, path: string): Promise<string | null> {
  const inside = relative(resolve(root), resolve(root, path))
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    return 'is outside of the source'
  }
  if (inside === '') {
    return null
  }
  let current = resolve(root)
  for (const part of inside.split(sep)) {
    current = join(current, part)
    const stats = await lstat(current).catch(() => undefined)
    if (!stats) {
      return null
    }
    if (stats.isSymbolicLink()) {
      return `goes through the symbolic link ${relative(root, current).split(sep).join('/')}`
    }
  }
  return null
}

export async function assertWithinRoot(root: string, path: string, describe: string): Promise<void> {
  const escape = await findRootEscape(root, path)
  if (escape) {
    throw new Error(`${describe} ${escape}`)
  }
}
