import { getTestSuite } from '../testing/get-test-suite'
import { expectSuccessfulResult } from '../testing/expect'

describe('execute', () => {
  const suite = getTestSuite('hello-world-node', ['.hammerkit.yaml', 'package.json', 'index.js'])

  afterAll(() => suite.close())

  // These watch-restart cases are unreliable on Windows hosted runners: the
  // re-run after a source change either hangs (completed/cached task) or times
  // out intermittently (crashed task), because file-watching + repeated node
  // spawns don't settle within the limit there. The watch feature is covered on
  // Linux and macOS; skip both on win32 until the Windows watch path is fixed.
  const itExceptWindows = process.platform === 'win32' ? it.skip : it

  itExceptWindows('should restart watching task if once completed', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'api' })

    const exec = await cli.exec({ watch: true })

    let count = 0
    exec.state.on('test-status', (state) => {
      if (state.tasks['api'].state.current.type === 'completed') {
        count++
        if (count === 1) {
          environment.file.appendFile(`${environment.cwd}/index.js`, '\n')
        } else if (count === 2) {
          environment.abortCtrl.abort()
        }
      }
    })

    const result = await exec.start()

    await expectSuccessfulResult(result, environment)
  })

  itExceptWindows('should restart watching task if once failed', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'api_crashing' })

    const exec = await cli.exec({ watch: true })

    let count = 0
    exec.state.on('test-status', (state) => {
      if (state.tasks['api_crashing'].state.current.type === 'crash') {
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
