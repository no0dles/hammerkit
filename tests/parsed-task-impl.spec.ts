import { ParsedLocalTaskImpl } from '../src/parsedLocalTaskImpl'
import { ParsedBuildFileImpl } from '../src/parsedBuildFileImpl'

describe('parsed-task-impl', () => {
  describe('getSources', () => {
    function testGlob(glob: string, expectedSource: string) {
      const build = new ParsedBuildFileImpl('test.yaml', {}, null)
      const task = new ParsedLocalTaskImpl(build, 'test', {
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
