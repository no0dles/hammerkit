export interface WorkNodeCacheFileStats {
  created: Date
  files: {
    [key: string]: { lastModified: number; checksum: string }
  }
}
export interface WorkServiceCacheFileStats {
  files: {
    [key: string]: { lastModified: number; checksum: string }
  }
}
