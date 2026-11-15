import { BigIntStats, constants } from 'fs'
import { lstat, open, readlink, stat } from 'fs/promises'
import { isAbsolute, join, relative, sep } from 'path'

/**
 * What `path`, inside `root`, is: its device and inode, reached from the root one name at a
 * time without following a link. On Linux each folder is opened with O_NOFOLLOW through the
 * descriptor of the one above (/proc/self/fd/<n>/<name>), and the last name is looked at
 * (lstat) through the descriptor of its folder, so a folder swapped for a link at any moment
 * is either refused or not looked at: the answer is never what a link led to.
 * Elsewhere (a machine of a developer) the names are checked for links, then the path read.
 * Throws when the path leaves the root, goes through a link, or can not be opened.
 */
export async function statBeneath(root: string, path: string): Promise<BigIntStats> {
  const inside = relative(root, path)
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error(`${path} is outside of ${root}`)
  }
  const parts = inside === '' ? [] : inside.split(sep)
  if (process.platform !== 'linux') {
    let current = root
    for (const part of parts) {
      current = join(current, part)
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`${path} goes through the symbolic link ${relative(root, current)}`)
      }
    }
    return stat(path, { bigint: true })
  }
  let handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    if ((await readlink(`/proc/self/fd/${handle.fd}`).catch(() => undefined)) === undefined) {
      throw new Error(`${path} can not be checked: /proc/self/fd is not readable`)
    }
    // the folders on the way are opened, the last name is only looked at, from the folder
    // above it, which is pinned by its descriptor: so a file the server may not read still
    // has an identity
    for (const [index, part] of parts.entries()) {
      const through = `/proc/self/fd/${handle.fd}/${part}`
      if (index === parts.length - 1) {
        const stats = await lstat(through, { bigint: true })
        if (stats.isSymbolicLink()) {
          throw new Error(`${path} goes through a symbolic link at ${parts.join('/')}`)
        }
        return stats
      }
      const next = await open(through, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY).catch((e) => {
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'ELOOP' || code === 'ENOTDIR') {
          throw new Error(`${path} goes through a symbolic link at ${parts.slice(0, index + 1).join('/')}`)
        }
        throw e
      })
      await handle.close()
      handle = next
    }
    return await handle.stat({ bigint: true })
  } finally {
    await handle.close()
  }
}
