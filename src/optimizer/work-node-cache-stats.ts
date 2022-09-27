export interface WorkNodeCacheFileStats {
  cwd: string
  files: {
    [key: string]: { lastModified: number; checksum: string }
  }
}
export interface WorkServiceCacheFileStats {
  files: {
    [key: string]: { lastModified: number; checksum: string }
  }
}
