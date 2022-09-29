import { getVirtualTestSuite } from '../testing/virtual-test-suite'

describe('execute', () => {
  const suite = getVirtualTestSuite({
    files: {
      'index.js': "console.log('hello')",
      'package.json': '{}',
    },
    buildFile: {
      tasks: {
        api: {
          cmds: ['node index.js'],
          src: ['index.js', 'package.json'],
        },
      },
    },
  })

  afterAll(() => suite.close())

  it('should restart watching task if once completed', async () => {
    const testCase = await suite.setup({ mockExecution: true })

    const apiMock = testCase.executionMock.task('api').set({
      exitCode: 0,
      duration: 10,
    })

    expect(apiMock.executeCount).toBe(0)

    const resultPromise = testCase.exec({ taskName: 'api' }, { watch: true })

    await wait(30)

    expect(apiMock.executeCount).toBe(1)

    await testCase.environment.file.appendFile(`${testCase.environment.cwd}/index.js`, '\n')

    await wait(130)

    expect(apiMock.executeCount).toBe(2)

    await testCase.environment.abortCtrl.abort()

    const result = await resultPromise
    expect(result.success).toBeTrue()
  })

  it('should restart watching task if once failed', async () => {
    const testCase = await suite.setup({ mockExecution: true })

    const apiMock = testCase.executionMock.task('api').set({ exitCode: 1, duration: 10 })

    expect(apiMock.executeCount).toBe(0)

    const resultPromise = testCase.exec({ taskName: 'api' }, { watch: true })

    await wait(30)
    expect(apiMock.executeCount).toBe(1)

    await testCase.environment.file.appendFile(`${testCase.environment.cwd}/index.js`, '\n')

    await wait(130)

    expect(apiMock.executeCount).toBe(2)

    await testCase.environment.abortCtrl.abort()

    const result = await resultPromise
    expect(result.success).toBeFalsy()
  })
})

async function wait(ms: number) {
  await new Promise<void>((resolve) => {
    setTimeout(() => resolve(), ms)
  })
}
