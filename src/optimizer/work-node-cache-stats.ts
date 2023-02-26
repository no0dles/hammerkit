export interface WorkCacheFileStats {
  created: Date
  files: {
    [key: string]: { lastModified: number; checksum: string }
  }
}
