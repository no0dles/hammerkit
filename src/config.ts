export interface BuildFile {
  envs?: { [key: string]: string }
  tasks?: { [key: string]: BuildFileTask | DockerBuildFileTask }
  includes?: { [key: string]: string }
  references?: { [key: string]: string }
}

export type BuildFileTaskCmd = string | { run: string; envs?: { [key: string]: string } }

export interface BuildFileTask {
  description?: string
  cmds?: BuildFileTaskCmd[]
  deps?: string[]
  src?: string[]
  generates?: string[]
  envs?: { [key: string]: string }
}

export interface DockerBuildFileTask extends BuildFileTask {
  image: string
  shell?: string
  mounts?: string[]
}

export const isDockerBuildFileTask = (val: BuildFileTask): val is DockerBuildFileTask => !!(<any>val).image
