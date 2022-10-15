import { getTestSuite } from '../testing/get-test-suite'

describe('execute', () => {
  const suite = getTestSuite('hello-world-node', ['build.yaml', 'package.json', 'index.js'])

  afterAll(() => suite.close())

  it('should restart watching task if once completed', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'api' })

    const node = cli.node('api')
    const exec = cli.execWatch({ watch: true })

    let count = 0
    exec.state.on((state) => {
      if (state.node[node.id].type === 'completed') {
        count++
        if (count === 1) {
          environment.file.appendFile(`${environment.cwd}/index.js`, '\n')
        } else if (count === 2) {
          environment.abortCtrl.abort()
        }
      }
    })

    const result = await exec.start()

    expect(result.success).toBeTruthy()
  })

  it('should restart watching task if once failed', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'api_crashing' })

    const node = cli.node('api_crashing')
    const exec = cli.execWatch({ watch: true })

    let count = 0
    exec.state.on((state) => {
      if (state.node[node.id].type === 'crash') {
        count++
        if (count === 1) {
          environment.file.appendFile(`${environment.cwd}/index.js`, '\n')
        } else if (count === 2) {
          environment.abortCtrl.abort()
        }
      }
    })

    const result = await exec.start()
    expect(result.success).toBeFalsy()
  })
})
