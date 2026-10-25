import { create, Pack, TarOptionsWithAliasesAsyncFile, TarOptionsWithAliasesAsyncNoFile } from 'tar'

// Packs `files` with node-tar, one file at a time. Since 7.5.14, node-tar packs a hard link
// only once the file it links to is written, and with more than one file being read at a
// time (`jobs`, 4 by default) that waits forever on a directory with a few hard links, or
// fails with "write after end" (seen on Windows). Reading one file at a time never waits,
// at the cost of packing a large tree more slowly (about 1.3x for a gzipped node_modules).
// Every archive hammerkit packs goes through here (.eslintrc keeps `create` out of the
// rest of src).
export function packArchive(options: TarOptionsWithAliasesAsyncNoFile, files: string[]): Pack
export function packArchive(options: TarOptionsWithAliasesAsyncFile, files: string[]): Promise<void>
export function packArchive(
  options: TarOptionsWithAliasesAsyncNoFile | TarOptionsWithAliasesAsyncFile,
  files: string[]
) {
  return create({ ...options, jobs: 1, linkCache: new ExactLinkCache() }, files)
}

// node-tar's key of a link cache, `dev:ino`
type LinkCacheKey = `${number}:${number}`

// node-tar packs a file with more than one link as a link to the first file it packed with
// the same `dev:ino`. On Windows a file id has 64 bits, and Node gives it as a number, so
// ids above 2^53 are rounded and files of two link groups can get the same one. Packed as
// a link, a file would be restored with the other file's content. This cache leaves out the
// ids that may be rounded, so those files are packed in full.
//
// node-tar asks the cache in two places. A WriteEntry links to the path it gets only when
// that path is in the packed directory, and packs the file in full otherwise. The Pack treats
// a file it gets no path for as the first of its links, and takes a path for it that ends
// the archive a second time ("write after end", thrown where nothing can catch it) when the
// file is empty and the last one packed: an empty file whose other link is outside the
// packed directory, as in a pnpm node_modules, or any empty file with a rounded id. With
// one file read at a time that path is not needed, so the cache never answers with nothing:
// for a file it has no path for, it answers NOT_PACKED, which is in no directory.
class ExactLinkCache extends Map<LinkCacheKey, string> {
  get(key: LinkCacheKey): string {
    return (isExact(key) && super.get(key)) || NOT_PACKED
  }

  set(key: LinkCacheKey, path: string): this {
    return isExact(key) ? super.set(key, path) : this
  }
}

const NOT_PACKED = '\0'

function isExact(key: LinkCacheKey): boolean {
  return key.split(':').every((part) => Number.isSafeInteger(Number(part)))
}
