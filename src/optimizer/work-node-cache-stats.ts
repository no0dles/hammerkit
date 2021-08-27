export interface WorkNodeCacheFileStats {
  cwd: string
  files: {
    [key: string]: { lastModified: number; checksum: string }
  }
}
