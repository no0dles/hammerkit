export interface WorkCommand {
  cwd: string
  cmd: string
  parsed: {
    command: string
    args: string[]
  }
  // Where the arguments after -- begin: a character offset into `cmd` and an
  // index into `parsed.args`. Unset when the command is as the build file has it.
  arguments?: { cmd: number; args: number }
}
