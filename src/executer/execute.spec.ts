import { getVirtualTestSuite } from '../testing/get-test-suite'

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
    const apiMock = testCase.executionMock.getNode('api')

    const resultPromise = testCase.exec('api', {
      watch: true,
    })

    await apiMock.waitFor('running')
    await apiMock.end(0)

    await testCase.environment.file.appendFile(`${testCase.environment.cwd}/index.js`, '\n')

    await apiMock.waitFor('running')
    await testCase.environment.abortCtrl.abort()

    const result = await resultPromise
    expect(result.success).toBeFalsy()
  })

  it('should restart watching task if once failed', async () => {
    const testCase = await suite.setup({ mockExecution: true })
    const apiMock = testCase.executionMock.getNode('api')

    const resultPromise = testCase.exec('api', {
      watch: true,
    })

    await apiMock.waitFor('running')
    await apiMock.end(1)

    await testCase.environment.file.appendFile(`${testCase.environment.cwd}/index.js`, '\n')

    await apiMock.waitFor('running')
    await testCase.environment.abortCtrl.abort()

    const result = await resultPromise
    expect(result.success).toBeFalsy()
  })
})
