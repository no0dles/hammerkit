export interface WorkMount {
  localPath: string
  containerPath: string
  isFile: boolean
  mount: string
  // `local:container:ro` - the container can't write it
  readOnly: boolean
}
