import { BuildFile } from '../src/build-file'
import { LocalTask } from '../src/local-task'

describe('parsed-task-impl', () => {
  describe('getSources', () => {
    function testGlob(glob: string, expectedSource: string) {
      const build = new BuildFile('test.yaml', {}, null)
      const task = new LocalTask(build, 'test', {
        cmds: [],
        src: [glob],
        envs: {},
        deps: [],
        description: ' ',
        generates: [],
      })
      expect(Array.from(task.getSources())[0].relativePath).toEqual(expectedSource)
    }

    it('should handle glob **', () => testGlob('**', '.'))
    it('should handle glob *', () => testGlob('*', '.'))
    it('should handle glob *.ts', () => testGlob('*.ts', '.'))
    it('should handle glob src/*.ts', () => testGlob('src/*.ts', 'src'))
    it('should handle glob src/**/*.ts', () => testGlob('src/**/*.ts', 'src'))
  })
})
