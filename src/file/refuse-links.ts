import { lstat } from 'fs/promises'
import { isAbsolute, join, relative, sep } from 'path'

/**
 * Refuses a path a run binds into a container or writes on the host when it is not inside
 * `root`, or when any part of it below `root` is a link. The files below `root` are
 * written by the run's own tasks, or by a commit somebody pushed: a link there would make
 * docker mount, or the engine write, whatever it points to on the server. `root` itself
 * is the server's. What does not exist yet is fine, the walk ends at the first missing
 * part.
 */
export async function refuseLinks(root: string, path: string): Promise<void> {
  const rel = relative(root, path)
  if (rel === '') {
    return
  }
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${path} is outside of ${root}`)
  }
  let current = root
  for (const segment of rel.split(sep)) {
    current = join(current, segment)
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new LinkError(`${relative(root, current)} is a link, a run may not mount or write through one`)
      }
    } catch (e) {
      if (e instanceof LinkError) {
        throw e
      }
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return
      }
      throw e
    }
  }
}

class LinkError extends Error {}
