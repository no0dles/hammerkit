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
  return create({ ...options, jobs: 1 }, files)
}
