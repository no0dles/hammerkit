// `--set NAME=value` / `--set=NAME=value` on any command, as often as needed:
// the value is what `$NAME` and `${NAME}` resolve to, ahead of the shell and
// `.env` files. Taken out of argv before commander parses it, like `--file`.
export function parseSetArguments(argv: string[]): { args: string[]; values: { [name: string]: string } } {
  const args: string[] = []
  const values: { [name: string]: string } = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--set') {
      const assignment = argv[index + 1]
      if (assignment === undefined) {
        throw new Error('--set expects NAME=value')
      }
      addAssignment(values, assignment)
      index++
    } else if (arg.startsWith('--set=')) {
      addAssignment(values, arg.substring('--set='.length))
    } else {
      args.push(arg)
    }
  }
  return { args, values }
}

function addAssignment(values: { [name: string]: string }, assignment: string): void {
  const separator = assignment.indexOf('=')
  const name = separator > 0 ? assignment.substring(0, separator) : ''
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`--set expects NAME=value, got "${assignment}"`)
  }
  values[name] = assignment.substring(separator + 1)
}
