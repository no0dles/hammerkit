import { createHash } from 'crypto'
import { Environment } from '../executer/environment'
import { FileContext, FileStats } from '../file/file-context'

interface KnownChecksum {
  lastModified: number
  size: number
  changed: number
  inode: number
  checksum: string
}

// The checksums a process computed, by the file context and path: every task of a run hashes
// the sources of the tasks it depends on too, so most files are asked for many times
const known = new WeakMap<FileContext, Map<string, KnownChecksum>>()

// A file written again soon after it was hashed, with the same size, keeps its times on a
// file system whose timestamps are coarser than that: a checksum of a file changed within
// the window before it was hashed is not kept. Whole seconds are taken for a file system
// that has no more (FAT, ext3, HFS+), else the window is short.
export function racyWindow(stats: Pick<FileStats, 'lastModified'> & { identity: { changed: number } }): number {
  return stats.lastModified % 1000 === 0 && stats.identity.changed % 1000 === 0 ? 2000 : 50
}

// Hashes the raw bytes: decoding to text first would map every invalid UTF-8
// sequence to U+FFFD, so two different binary files could share a checksum.
// For UTF-8 text the result is unchanged. sha256, which nobody can make two files share:
// a cache hit is also what a verified check counts (check-key.ts).
//
// With the `stats` of the file, the checksum is reused while the file stays the same file:
// the same modification and change time, size and inode. A write changes its times, a
// replacement (a checkout, a rename over it) its inode.
export async function calculateChecksum(environment: Environment, path: string, stats?: FileStats): Promise<string> {
  const identity = stats?.identity
  if (!identity) {
    return hashFile(environment, path)
  }
  let files = known.get(environment.file)
  if (!files) {
    files = new Map()
    known.set(environment.file, files)
  }
  const cached = files.get(path)
  if (
    cached &&
    cached.lastModified === stats.lastModified &&
    cached.size === identity.size &&
    cached.changed === identity.changed &&
    cached.inode === identity.inode
  ) {
    return cached.checksum
  }
  const hashedAt = Date.now()
  const checksum = await hashFile(environment, path)
  if (hashedAt - Math.max(stats.lastModified, identity.changed) > racyWindow({ ...stats, identity })) {
    files.set(path, { lastModified: stats.lastModified, ...identity, checksum })
  } else {
    files.delete(path)
  }
  return checksum
}

async function hashFile(environment: Environment, path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of environment.file.readStream(path)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}
