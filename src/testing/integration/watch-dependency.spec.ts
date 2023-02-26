import { getTestSuite } from '../get-test-suite'

describe('watch-dependency', () => {
  const suite = getTestSuite('watch-dependency', ['.hammerkit.yaml', 'source.txt'])

  afterAll(() => suite.close())

  it('should run watch task', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'third' })
    const thirdNode = cli.task('third')
    const exec = await cli.exec({ watch: true })

    let content = ''
    let changedStateKey = ''
    exec.state.on('test-status', async (evt) => {
      const currentState = evt.tasks[thirdNode.name].state.current
      if (currentState.type === 'completed') {
        if (
          changedStateKey != '' &&
          currentState.stateKey !== changedStateKey &&
          !environment.abortCtrl.signal.aborted
        ) {
          content = await environment.file.read('third.txt')
          environment.abortCtrl.abort()
        } else if (changedStateKey === '') {
          await environment.file.appendFile('source.txt', 'world\n')
          changedStateKey = currentState.stateKey
        }
      }
    })
    const result = await exec.start()
    expect(result.success).toBeTruthy()
    expect(content).toEqual('hello\nworld\nfirst step\nsecond step\nthird step\n')
  })
})
