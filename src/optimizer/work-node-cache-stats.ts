import { WorkNodeDescription } from './work-node-description'

export interface WorkNodeCacheStats {
  stats: WorkNodeCacheFileStats
  task: WorkNodeDescription
}

export interface WorkNodeCacheFileStats {
  [key: string]: { lastModified: number; checksum: string }
}
