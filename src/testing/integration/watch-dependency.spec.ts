import { getTestSuite } from '../get-test-suite'

describe('watch-dependency', () => {
  const suite = getTestSuite('watch-dependency', ['.hammerkit.yaml', 'source.txt'])

  afterAll(() => suite.close())

  it('should run watch task', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'third' })
    const thirdNode = cli.node('third')
    const exec = await cli.exec({ watch: true })

    let content = ''
    let changed = false
    exec.processManager.on(async (evt) => {
      if (evt.type === 'ended' && evt.context.id === thirdNode.id) {
        if (changed) {
          content = await environment.file.read('third.txt')
          environment.abortCtrl.abort()
        } else {
          await environment.file.appendFile('source.txt', 'world\n')
          changed = true
        }
      }
    })
    const result = await exec.start()
    expect(result.success).toBeTruthy()
    expect(content).toEqual('hello\nworld\nfirst step\nsecond step\nthird step\n')
  })
})
