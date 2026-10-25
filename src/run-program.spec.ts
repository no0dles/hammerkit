import { createTestCase } from './testing/test-case'
import { memoryStream } from './testing/test-streams'
import { runProgram } from './run-program'

describe('run-program', () => {
  it('should print a YAML error of an included file, with the file and the line', async () => {
    const testCase = createTestCase('run-program-yaml-include', {
      '.hammerkit.yaml': 'includes:\n  services: ./services.yaml\ntasks:\n  a:\n    cmds: [echo a]\n',
      // a `: ` inside a plain scalar is a nested mapping YAML refuses
      'services.yaml':
        'services:\n  postgres:\n    image: postgres\n    healthcheck:\n      cmd: pg_isready -h localhost: 5432\n',
    })
    await testCase.setup(async (cwd, environment) => {
      const stderr = memoryStream()
      environment.stderr = stderr.stream
      await expect(runProgram(environment, ['hammerkit', 'ls'], true)).rejects.toThrow('unable to parse')
      expect(stderr.read()).toContain('services.yaml')
      expect(stderr.read()).toContain('at line 5')
    })
  })

  it('should fail on a build file that does not match the schema, after printing why', async () => {
    const testCase = createTestCase('run-program-schema', {
      '.hammerkit.yaml': 'tasks:\n  a:\n    bogus: 1\n',
    })
    await testCase.setup(async (cwd, environment) => {
      const stderr = memoryStream()
      environment.stderr = stderr.stream
      await expect(runProgram(environment, ['hammerkit', 'ls'], true)).rejects.toThrow()
      expect(stderr.read()).toContain('bogus')
    })
  })

  it('should not print what commander already reported', async () => {
    const testCase = createTestCase('run-program-commander', {
      '.hammerkit.yaml': 'tasks:\n  a:\n    cmds: [echo a]\n',
    })
    await testCase.setup(async (cwd, environment) => {
      const stderr = memoryStream()
      environment.stderr = stderr.stream
      await expect(runProgram(environment, ['hammerkit', 'run', 'missing'], true)).rejects.toThrow('No tasks found')
      expect(stderr.read()).not.toContain('No tasks found')
    })
  })

  it('prints the error of a command that says it itself once', async () => {
    const testCase = createTestCase('run-program-said', { '.hammerkit.yaml': 'tasks:\n  a:\n    cmds: [echo a]\n' })
    await testCase.setup(async (cwd, environment) => {
      const stderr = memoryStream()
      environment.stderr = stderr.stream
      environment.processEnvs = { PATH: process.env.PATH }
      await expect(runProgram(environment, ['hammerkit', 'github-app-token', 'corp/repo'], true)).rejects.toThrow(
        'GITHUB_APP_ID is not set'
      )
      expect(stderr.read()).toBe('github-app-token: GITHUB_APP_ID is not set\n')
    })
  })
})
