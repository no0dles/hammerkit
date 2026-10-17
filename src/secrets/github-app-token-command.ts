import { Command } from 'commander'
import { Environment } from '../executer/environment'
import { getErrorMessage } from '../log'
import { githubAppToken } from './github-app-token'

// `hammerkit github-app-token <owner/repo>`: a secret provider command for the token a
// server reads and pushes a repository with, so the released binary mints it without a
// script or a runtime of its own. It prints the token and nothing else, without a newline.
export function registerGithubAppTokenCommand(program: Command, environment: Environment): void {
  program
    .command('github-app-token <repo>')
    .description('print an installation token of a GitHub App for one repository (a secret provider command)')
    .action(async (repo: string) => {
      try {
        environment.stdout.write(await githubAppToken(repo, environment.processEnvs))
      } catch (e) {
        program.error(`github-app-token: ${getErrorMessage(e)}`, { exitCode: 1 })
      }
    })
}
