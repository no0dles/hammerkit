import { getProgram } from './program'
import { ParseError } from './schema/parse-error'
import colors from 'colors'
import { Environment } from './executer/environment'
import { CommanderError } from 'commander'
import { getErrorMessage } from './log'

export function runProgram(env: Environment, argv: string[], exitOverride: boolean) {
  return getProgram(env, argv)
    .then(({ program, args }) => {
      return exitOverride ? program.exitOverride().parseAsync([env.cwd, ...args]) : program.parseAsync(args)
    })
    .catch((err) => {
      if (err instanceof ParseError) {
        env.stderr.write(`${colors.underline(colors.gray(err.buildFilePath))}\n`)
        for (const error of err.zod.errors) {
          env.stderr.write(
            ` ${colors.underline(colors.blue(`error`))} at ${colors.gray(error.path.join('.'))} ${
              error.message
            }  ${colors.gray(error.code)}\n`
          )
        }
        // printed, but still a failure: CI must not pass on a build file that doesn't parse
        throw err
      } else {
        // what commander reports (program.error, a wrong option) is printed already; anything
        // else, such as a build file that is no YAML, would otherwise end the process silently
        if (!(err instanceof CommanderError)) {
          env.stderr.write(`${colors.red('error')}: ${getErrorMessage(err)}\n`)
        }
        throw err
      }
    })
}
