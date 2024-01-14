export interface WorkCommand {
  cwd: string
  cmd: string
  parsed: {
    command: string
    args: string[]
  }
}
