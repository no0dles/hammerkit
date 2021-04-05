import {ParsedBuildFileTask} from './parsedBuildFileTask';

export interface ParsedDockerBuildFileTask extends ParsedBuildFileTask {
  image: string
  entrypoint?: string
  mounts: string[]
}
