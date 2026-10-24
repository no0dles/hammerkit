// Options for every archive hammerkit packs with node-tar. Since 7.5.14, node-tar packs a
// hard link only once the file it links to is written, and with more than one file being
// read at a time (`jobs`, 4 by default) that waits forever on a directory with a few hard
// links, or fails with "write after end" (seen on Windows). Reading one file at a time
// never waits.
export const packOptions = { jobs: 1 } as const
