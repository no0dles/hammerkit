import { getProgram } from './program'
import { ParseError } from './schema/parse-error'
import colors from 'colors'
import { Environment } from './executer/environment'

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
      } else {
        throw err
      }
    })
}
